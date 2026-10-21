// Aggregation for the enterprise dashboard.
//
// Usage is reported by clients (one event per model turn) rather than scraped
// from provider invoices, so these numbers are the tenant's own record. Every
// function is pure and takes `now`, which makes the dashboard testable without
// freezing the clock.

import type { EnterpriseUser, UsageBucket, UsageEvent, UsageInsightRow, UsageInsights } from "./types"

export const USAGE_WINDOWS = [1, 7, 14, 30, 90] as const
export type UsageWindow = (typeof USAGE_WINDOWS)[number]

export function isUsageWindow(value: unknown): value is UsageWindow {
  return typeof value === "number" && (USAGE_WINDOWS as readonly number[]).includes(value)
}

export function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

export function windowStart(days: number, now: number): number {
  return now - days * 24 * 60 * 60 * 1000
}

export function usageInWindow(usage: readonly UsageEvent[], days: number, now: number): UsageEvent[] {
  const start = windowStart(days, now)
  return usage.filter((event) => event.at >= start && event.at <= now)
}

function emptyBucket(key: string): UsageBucket {
  return { key, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
}

function add(bucket: UsageBucket, event: UsageEvent) {
  bucket.requests += 1
  bucket.inputTokens += event.inputTokens
  bucket.outputTokens += event.outputTokens
  bucket.costUsd += event.costUsd
}

function fold(events: readonly UsageEvent[], keyOf: (event: UsageEvent) => string): UsageBucket[] {
  const buckets = new Map<string, UsageBucket>()
  for (const event of events) {
    const key = keyOf(event)
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = emptyBucket(key)
      buckets.set(key, bucket)
    }
    add(bucket, event)
  }
  return [...buckets.values()]
}

export function byDay(events: readonly UsageEvent[], days: number, now: number): UsageBucket[] {
  const buckets = new Map<string, UsageBucket>()
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const key = dayKey(now - offset * 24 * 60 * 60 * 1000)
    buckets.set(key, emptyBucket(key))
  }
  for (const event of events) {
    const key = dayKey(event.at)
    const bucket = buckets.get(key)
    if (bucket !== undefined) add(bucket, event)
  }
  return [...buckets.values()]
}

export function byModel(events: readonly UsageEvent[], limit = 12): UsageBucket[] {
  return fold(events, (event) => event.model || "unknown").sort((a, b) => b.costUsd - a.costUsd).slice(0, limit)
}

export function byUser(events: readonly UsageEvent[], users: readonly EnterpriseUser[], limit = 12): UsageBucket[] {
  const labels = new Map(users.map((user) => [user.id, user.email || user.name || user.id]))
  return fold(events, (event) => labels.get(event.userId) ?? event.userId)
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, limit)
}

export function byTool(events: readonly UsageEvent[], limit = 12): UsageBucket[] {
  return fold(
    events.filter((event) => event.tool !== undefined && event.tool.length > 0),
    (event) => event.tool!,
  )
    .sort((a, b) => b.requests - a.requests)
    .slice(0, limit)
}

export function totals(events: readonly UsageEvent[]) {
  return events.reduce(
    (sum, event) => ({
      requests: sum.requests + 1,
      inputTokens: sum.inputTokens + event.inputTokens,
      outputTokens: sum.outputTokens + event.outputTokens,
      costUsd: sum.costUsd + event.costUsd,
      activeUsers: sum.activeUsers,
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, activeUsers: 0 },
  )
}

export function activeUsers(events: readonly UsageEvent[]): number {
  return new Set(events.map((event) => event.userId)).size
}

/** Buckets by arbitrary key, newest buckets first, used by the usage explorer. */
export function byKey(events: readonly UsageEvent[], key: "day" | "user" | "model" | "tool", users: readonly EnterpriseUser[]): UsageBucket[] {
  if (key === "day") {
    const days = fold(events, (event) => dayKey(event.at))
    return days.sort((a, b) => (a.key < b.key ? 1 : -1))
  }
  if (key === "user") {
    const labels = new Map(users.map((user) => [user.id, user.email || user.name || user.id]))
    return fold(events, (event) => labels.get(event.userId) ?? event.userId).sort((a, b) => b.costUsd - a.costUsd)
  }
  if (key === "model") return fold(events, (event) => event.model || "unknown").sort((a, b) => b.costUsd - a.costUsd)
  return fold(
    events.filter((event) => event.tool !== undefined && event.tool.length > 0),
    (event) => event.tool!,
  ).sort((a, b) => b.requests - a.requests)
}

/**
 * A denser read of the same reported events: efficiency, concentration,
 * calendar-month spend and days that sit well outside the tenant's own
 * baseline. Pure, so the numbers can be tested against a fixed clock.
 */
export function insights(events: readonly UsageEvent[], users: readonly EnterpriseUser[], days: number, now: number): UsageInsights {
  const inWindow = usageInWindow(events, days, now)
  const total = { ...totals(inWindow), activeUsers: activeUsers(inWindow) }
  const userById = new Map(users.map((user) => [user.id, user]))
  const label = (id: string) => {
    const user = userById.get(id)
    return user === undefined ? id : user.email || user.name || id
  }
  const row = (bucket: UsageBucket, text: string): UsageInsightRow => ({
    ...bucket,
    label: text,
    share: percent(bucket.costUsd, total.costUsd),
    averageCostUsd: round(bucket.requests > 0 ? bucket.costUsd / bucket.requests : 0, 6),
    tokensPerRequest: Math.round(bucket.requests > 0 ? (bucket.inputTokens + bucket.outputTokens) / bucket.requests : 0),
  })
  const models = byModel(inWindow, 50).map((bucket) => row(bucket, bucket.key))
  const people = fold(inWindow, (event) => event.userId)
    .map((bucket) => row(bucket, label(bucket.key)))
    .sort((a, b) => b.costUsd - a.costUsd)
  const departments = fold(
    inWindow,
    (event) => userById.get(event.userId)?.department?.trim() || "Unassigned",
  )
    .map((bucket) => row(bucket, bucket.key))
    .sort((a, b) => b.costUsd - a.costUsd)
  const tools = fold(
    inWindow.filter((event) => event.tool !== undefined && event.tool.length > 0),
    (event) => event.tool!,
  )
    .map((bucket) => row(bucket, bucket.key))
    .sort((a, b) => b.requests - a.requests)
  const durations = inWindow.flatMap((event) => (event.durationMs === undefined || event.durationMs <= 0 ? [] : [event.durationMs]))
  const monthStart = new Date(now)
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const monthToDate = events.filter((event) => event.at >= monthStart.getTime() && event.at <= now)
  const daily = byDay(inWindow, days, now)
  const median = medianCost(daily)
  const anomalies = daily
    .filter((bucket) => bucket.costUsd > 0 && median > 0 && bucket.costUsd >= median * 2.5)
    .map((bucket) => ({ day: bucket.key, costUsd: round(bucket.costUsd, 6), multiple: round(bucket.costUsd / median, 2) }))
  const ranked = [...people].sort((a, b) => b.costUsd - a.costUsd)
  const topFive = ranked.slice(0, 5).reduce((sum, entry) => sum + entry.costUsd, 0)
  const decile = ranked.slice(0, Math.max(1, Math.ceil(ranked.length * 0.1))).reduce((sum, entry) => sum + entry.costUsd, 0)
  const tokens = total.inputTokens + total.outputTokens
  return {
    days,
    daily,
    models,
    people,
    departments,
    tools,
    efficiency: {
      tokensPerRequest: Math.round(total.requests > 0 ? tokens / total.requests : 0),
      costPer1kTokens: round(tokens > 0 ? (total.costUsd / tokens) * 1_000 : 0, 6),
      inputShare: percent(total.inputTokens, tokens),
      costPerActiveUser: round(total.activeUsers > 0 ? total.costUsd / total.activeUsers : 0, 4),
      requestsPerActiveUser: Math.round(total.activeUsers > 0 ? total.requests / total.activeUsers : 0),
      averageDurationMs: durations.length > 0 ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    },
    forecast: {
      dailyAverageUsd: round(total.costUsd / Math.max(1, days), 6),
      next30DaysUsd: round((total.costUsd / Math.max(1, days)) * 30, 4),
      monthToDateUsd: round(monthToDate.reduce((sum, event) => sum + event.costUsd, 0), 6),
    },
    concentration: {
      topFiveShare: percent(topFive, total.costUsd),
      topDecileShare: percent(decile, total.costUsd),
    },
    anomalies,
  }
}

function medianCost(buckets: readonly UsageBucket[]): number {
  const values = buckets.map((bucket) => bucket.costUsd).filter((value) => value > 0).sort((a, b) => a - b)
  if (values.length === 0) return 0
  const middle = Math.floor(values.length / 2)
  return values.length % 2 === 0 ? (values[middle - 1]! + values[middle]!) / 2 : values[middle]!
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function percent(part: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((part / total) * 1000) / 10
}
