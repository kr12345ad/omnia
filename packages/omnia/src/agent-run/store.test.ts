import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ScheduledRunStore, RUN_LIMITS } from "./store"

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function makeStore(): { store: ScheduledRunStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "omnia-runs-"))
  dirs.push(dir)
  const file = join(dir, "scheduled-runs.json")
  return { store: new ScheduledRunStore({ file }), file }
}

const valid = { profileId: "profile-1", name: "Morning summary", prompt: "Summarize my unread email.", intervalMinutes: 60 }

describe("scheduled run store", () => {
  test("saves, lists, updates, and removes runs", () => {
    const { store } = makeStore()
    const saved = store.save(valid)
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(store.list()).toHaveLength(1)
    expect(store.get(saved.run.id)?.name).toBe("Morning summary")

    const renamed = store.update(saved.run.id, { name: "Daily summary", enabled: false })
    expect(renamed.ok).toBe(true)
    if (renamed.ok) {
      expect(store.get(saved.run.id)?.name).toBe("Daily summary")
      expect(store.get(saved.run.id)?.enabled).toBe(false)
    }

    expect(store.remove(saved.run.id)).toBe(true)
    expect(store.remove(saved.run.id)).toBe(false)
    expect(store.list()).toHaveLength(0)
  })

  test("rejects invalid input without writing", () => {
    const { store } = makeStore()
    expect(store.save({ ...valid, name: "" }).ok).toBe(false)
    expect(store.save({ ...valid, prompt: "   " }).ok).toBe(false)
    expect(store.save({ ...valid, intervalMinutes: RUN_LIMITS.minIntervalMinutes - 1 }).ok).toBe(false)
    expect(store.save({ ...valid, intervalMinutes: RUN_LIMITS.maxIntervalMinutes + 1 }).ok).toBe(false)
    expect(store.list()).toHaveLength(0)
  })

  test("caps the roster", () => {
    const { store } = makeStore()
    for (let i = 0; i < RUN_LIMITS.maxRuns; i += 1) {
      expect(store.save({ ...valid, name: `Run ${i}` }).ok).toBe(true)
    }
    expect(store.save({ ...valid, name: "One too many" }).ok).toBe(false)
  })

  test("due() fires by interval since creation or last fire", () => {
    const { store } = makeStore()
    const saved = store.save(valid)
    if (!saved.ok) throw new Error("save failed")
    const now = Date.now()
    expect(store.due(now)).toHaveLength(0)
    expect(store.due(now + 60 * 60_000)).toHaveLength(1)
    expect(store.due(now + 59 * 60_000)).toHaveLength(0)

    store.update(saved.run.id, { enabled: false })
    expect(store.due(now + 60 * 60_000)).toHaveLength(0)
  })

  test("a corrupt file reads as empty and a later save overwrites nothing else", () => {
    const { store, file } = makeStore()
    require("node:fs").writeFileSync(file, "{ truncated")
    expect(store.list()).toEqual([])
    const saved = store.save(valid)
    expect(saved.ok).toBe(true)
  })

  test("refuses to write through a symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-runs-link-"))
    dirs.push(dir)
    const target = join(dir, "victim.json")
    require("node:fs").writeFileSync(target, "{}")
    symlinkSync(target, join(dir, "scheduled-runs.json"))
    const s = new ScheduledRunStore({ file: join(dir, "scheduled-runs.json") })
    expect(() => s.save(valid)).toThrow("symlink")
    expect(readFileSync(target, "utf8")).toBe("{}")
  })
})
