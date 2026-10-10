import { describe, expect, test } from "bun:test"
import { EventBus } from "./events"
import { RemoteRegistry } from "./remote"

function createRegistry(): RemoteRegistry {
  return new RemoteRegistry({
    events: new EventBus({ serverId: "test" }),
    registerDriver: () => () => undefined,
    randomToken: () => "token-1",
    randomComputerId: () => "remote-1",
    reapIntervalMs: 5,
  })
}

describe("link signaling relay", () => {
  test("delivers a link signal to the computer and resolves with its answer", async () => {
    const registry = createRegistry()
    try {
      const claimed = registry.claim({ name: "Remote", platform: "linux" })
      const pending = registry.signal(claimed.computerId, { linkId: "link-1", kind: "offer" }, 500)
      const command = await registry.next(claimed.computerId, 500)
      expect(command).toMatchObject({ method: "link-signal", params: { linkId: "link-1", kind: "offer" } })
      registry.complete(claimed.computerId, { id: command!.id, ok: true, result: { kind: "answer" } })
      await expect(pending).resolves.toEqual({ kind: "answer" })
    } finally {
      registry.close()
    }
  })

  test("rejects signals for unknown computers without queueing anything", async () => {
    const registry = createRegistry()
    try {
      await expect(registry.signal("no-such-computer", { kind: "offer" }, 50)).rejects.toThrow("Unknown computer")
      expect(registry.ids()).toEqual([])
    } finally {
      registry.close()
    }
  })

  test("rejects oversized signal payloads before they reach the queue", async () => {
    const registry = createRegistry()
    try {
      const claimed = registry.claim({ name: "Remote", platform: "linux" })
      await expect(registry.signal(claimed.computerId, { blob: "x".repeat(20000) }, 50)).rejects.toThrow("too large")
      expect(await registry.next(claimed.computerId, 20)).toBeUndefined()
    } finally {
      registry.close()
    }
  })
})
