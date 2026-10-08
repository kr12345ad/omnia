import { describe, expect, test } from "bun:test"
import { RunScheduler } from "./scheduler"
import { ScheduledRunStore } from "./store"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

function harness(options: { gate?: (run: { id: string }) => Promise<{ allowed: boolean; reason?: string }> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omnia-sched-"))
  const store = new ScheduledRunStore({ file: join(dir, "runs.json") })
  const fired: string[] = []
  const config = { url: "http://127.0.0.1:9", username: "opencode", password: "x" } as const
  // The scheduler's runner is exercised against a tiny fake opencode server.
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const key = `${request.method} ${url.pathname}`
      if (key === "POST /session") return Response.json({ id: "ses_fake", title: "t" })
      if (key === "POST /session/ses_fake/prompt_async") return Response.json({})
      if (key === "GET /session/status") return Response.json({ ses_fake: { type: "idle" } })
      if (key === "GET /session/ses_fake/message") return Response.json([])
      return new Response("not found", { status: 404 })
    },
  })
  const cleanup = () => {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
  return { store, fired, config: { ...config, url: server.url.origin }, server, cleanup, options }
}

describe("run scheduler", () => {
  test("fires a due run once and records the outcome", async () => {
    const { store, config, cleanup } = harness()
    try {
      const saved = store.save({ profileId: "profile-1", name: "tick", prompt: "go", intervalMinutes: 15 })
      expect(saved.ok).toBe(true)
      if (!saved.ok) return
      const scheduler = new RunScheduler({
        config,
        store,
        tickMs: 10_000,
        timeoutMs: 5_000,
        now: () => Date.now() + 20 * 60_000,
      })
      const fired = await scheduler.tick()
      expect(fired).toBe(1)
      const run = store.get(saved.run.id)
      expect(run?.lastResult?.ok).toBe(true)
      expect(run?.lastResult?.sessionId).toBe("ses_fake")
      // The interval is measured from this firing, so an immediate re-tick does nothing.
      expect(await scheduler.tick()).toBe(0)
    } finally {
      cleanup()
    }
  })

  test("a refused gate records the refusal and never reaches the opencode server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-sched-gate-"))
    const store = new ScheduledRunStore({ file: join(dir, "runs.json") })
    try {
      store.save({ profileId: "profile-1", name: "tick", prompt: "go", intervalMinutes: 15 })
      const config = { url: "http://127.0.0.1:9", username: "opencode", password: "x" } as const
      const scheduler = new RunScheduler({
        config,
        store,
        timeoutMs: 5_000,
        now: () => Date.now() + 20 * 60_000,
        gate: async () => ({ allowed: false, reason: "Scheduled runs are not included in this plan." }),
      })
      await scheduler.tick()
      const run = store.list()[0]
      expect(run?.lastResult?.ok).toBe(false)
      expect(run?.lastResult?.error).toContain("not included")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("skips disabled runs and re-checks enablement between fires", async () => {
    const { store, config, cleanup } = harness()
    try {
      const saved = store.save({ profileId: "profile-1", name: "tick", prompt: "go", intervalMinutes: 15 })
      if (!saved.ok) return
      store.update(saved.run.id, { enabled: false })
      const scheduler = new RunScheduler({
        config,
        store,
        timeoutMs: 5_000,
        now: () => Date.now() + 20 * 60_000,
      })
      expect(await scheduler.tick()).toBe(0)
    } finally {
      cleanup()
    }
  })
})
