import { describe, expect, test } from "bun:test"
import { insights } from "./metrics"
import type { EnterpriseUser, UsageEvent } from "./types"

const now = Date.UTC(2026, 9, 18, 12)
const day = 24 * 60 * 60 * 1000

function user(id: string, email: string, department?: string): EnterpriseUser {
  return {
    id,
    email,
    name: email.split("@")[0]!,
    role: "member",
    status: "active",
    groupIds: [],
    createdAt: now,
    updatedAt: now,
    mfaEnabled: false,
    seat: true,
    ...(department === undefined ? {} : { department }),
  }
}

function event(input: {
  at: number
  userId: string
  costUsd: number
  inputTokens?: number
  outputTokens?: number
  durationMs?: number
  tool?: string
  model?: string
}): UsageEvent {
  return {
    id: `evt_${Math.random().toString(36).slice(2)}`,
    at: input.at,
    userId: input.userId,
    model: input.model ?? "opencode/big",
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    costUsd: input.costUsd,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.tool === undefined ? {} : { tool: input.tool }),
  }
}

const users = [user("u1", "ada@acme.com", "Engineering"), user("u2", "grace@acme.com", "Sales"), user("u3", "linus@acme.com", "Engineering")]

const events = [
  event({ at: now, userId: "u1", costUsd: 10, inputTokens: 1000, outputTokens: 500, durationMs: 2000, tool: "shell" }),
  event({ at: now - 60_000, userId: "u2", costUsd: 5, tool: "read" }),
  event({ at: now - day, userId: "u1", costUsd: 1 }),
  event({ at: now - 2 * day, userId: "u3", costUsd: 1 }),
  // Outside the 7-day window but inside the calendar month.
  event({ at: now - 16 * day, userId: "u1", costUsd: 3 }),
]

describe("usage insights", () => {
  test("summarizes efficiency and the reporting window", () => {
    const result = insights(events, users, 7, now)
    expect(result.days).toBe(7)
    expect(result.daily).toHaveLength(7)
    expect(result.efficiency.tokensPerRequest).toBe(375)
    expect(result.efficiency.inputShare).toBe(66.7)
    expect(result.efficiency.costPer1kTokens).toBeCloseTo(11.333333, 5)
    expect(result.efficiency.costPerActiveUser).toBeCloseTo(17 / 3, 4)
    expect(result.efficiency.requestsPerActiveUser).toBe(1)
    expect(result.efficiency.averageDurationMs).toBe(2000)
    expect(result.forecast.monthToDateUsd).toBe(20)
    expect(result.forecast.dailyAverageUsd).toBeCloseTo(17 / 7, 5)
  })

  test("groups spend by person and department", () => {
    const result = insights(events, users, 7, now)
    expect(result.people.map((row) => row.label)).toEqual(["ada@acme.com", "grace@acme.com", "linus@acme.com"])
    expect(result.departments.map((row) => row.label)).toEqual(["Engineering", "Sales"])
    expect(result.departments[0]!.costUsd).toBe(12)
    expect(result.concentration.topFiveShare).toBe(100)
    expect(result.concentration.topDecileShare).toBe(64.7)
  })

  test("flags anomalous days against the tenant's own baseline", () => {
    const result = insights(events, users, 7, now)
    expect(result.anomalies).toEqual([{ day: "2026-10-18", costUsd: 15, multiple: 15 }])
  })

  test("falls back to unassigned departments and empty tools", () => {
    const result = insights(
      [event({ at: now, userId: "u4", costUsd: 2, inputTokens: 10, outputTokens: 10 })],
      [...users, user("u4", "unknown@acme.com")],
      7,
      now,
    )
    expect(result.departments.map((row) => row.label)).toEqual(["Unassigned"])
    expect(result.tools).toEqual([])
    expect(result.efficiency.averageDurationMs).toBe(0)
  })
})
