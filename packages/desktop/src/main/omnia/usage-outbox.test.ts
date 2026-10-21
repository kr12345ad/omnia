import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createUsageOutbox, type UsageEvent } from "./usage-outbox"

// The outbox is the part of usage reporting that outlives the window. Its
// failure mode is silent — a laptop offline at the wrong moment — so what is
// worth pinning is exactly what leaves the machine and what must not: one event
// per turn, a refused batch kept for the next attempt, and a queue deleted when
// the organization turns telemetry off.

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function outbox(overrides: { allowed?: () => Promise<boolean>; send?: (events: UsageEvent[]) => Promise<boolean> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "omnia-usage-outbox-"))
  directories.push(directory)
  const sent: UsageEvent[][] = []
  const retries: (() => void)[] = []
  const instance = createUsageOutbox({
    file: join(directory, "usage.json"),
    allowed: overrides.allowed ?? (async () => true),
    send:
      overrides.send ??
      (async (events) => {
        sent.push(events)
        return true
      }),
    // Tests drive retries themselves instead of waiting a minute.
    schedule: (task) => retries.push(task),
  })
  return { instance, sent, retries, directory }
}

const turn = {
  key: "msg_turn_1",
  model: "anthropic/claude-sonnet-4",
  provider: "anthropic",
  inputTokens: 1_200,
  outputTokens: 300,
  costUsd: 0.02,
  durationMs: 5_000,
  sessionId: "ses_1",
}

describe("usage outbox", () => {
  test("queues a turn once and survives a restart", async () => {
    const first = outbox()
    expect(first.instance.report(turn)).toEqual({ queued: true, pending: 1 })
    // A replayed session event must not bill the turn twice.
    expect(first.instance.report(turn)).toEqual({ queued: false, pending: 1 })

    const reopened = createUsageOutbox({
      file: join(first.directory, "usage.json"),
      allowed: async () => true,
      send: async (events) => {
        first.sent.push(events)
        return true
      },
    })
    expect(reopened.pending()).toBe(1)
    await reopened.flush()
    expect(first.sent).toHaveLength(1)
    expect(first.sent[0]?.[0]).toMatchObject({ model: "anthropic/claude-sonnet-4", inputTokens: 1_200, sessionId: "ses_1" })
  })

  test("keeps a refused batch and retries it", async () => {
    const { instance, sent, retries } = outbox({ send: async () => false })
    instance.report(turn)
    await instance.flush()
    expect(sent).toHaveLength(0)
    expect(instance.pending()).toBe(1)
    expect(retries).toHaveLength(1)
  })

  test("deletes the queue when telemetry is off", async () => {
    const { instance, sent } = outbox({ allowed: async () => false })
    instance.report(turn)
    await instance.flush()
    expect(sent).toHaveLength(0)
    expect(instance.pending()).toBe(0)
  })

  test("ignores a payload without a key or a model", async () => {
    const { instance } = outbox()
    expect(instance.report({ model: "anthropic/claude-sonnet-4" })).toEqual({ queued: false, pending: 0 })
    expect(instance.report({ key: "msg_x" })).toEqual({ queued: false, pending: 0 })
  })

  test("drops the oldest events beyond the queue ceiling", () => {
    const { instance } = outbox()
    for (let index = 0; index < 1_005; index += 1) instance.report({ ...turn, key: `msg_${index}` })
    expect(instance.pending()).toBe(1_000)
  })
})
