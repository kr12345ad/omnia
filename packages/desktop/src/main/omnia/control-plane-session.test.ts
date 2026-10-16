import { describe, expect, test } from "bun:test"
import { watchControlPlaneSession } from "./control-plane-session"

const TICK_MS = 5
// Several ticks plus the restart they trigger, so no test depends on one exact
// timer firing.
const SETTLE_MS = 60

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe("control-plane session watch", () => {
  test("re-forks the sidecar once a session appears", async () => {
    let fingerprint: string | undefined
    const restarts: Array<string | undefined> = []
    const watch = watchControlPlaneSession({
      fingerprint: () => fingerprint,
      restart: async () => {
        restarts.push(fingerprint)
      },
      intervalMs: TICK_MS,
      onError: (error) => {
        throw error
      },
    })
    try {
      // Signed out and staying signed out is not a reason to fork again.
      await Bun.sleep(SETTLE_MS)
      expect(restarts).toEqual([])

      fingerprint = "https://cp.example.com\nclient-token"
      await Bun.sleep(SETTLE_MS)
      expect(restarts).toEqual(["https://cp.example.com\nclient-token"])
      expect(watch.applied()).toBe("https://cp.example.com\nclient-token")

      // The session the running sidecar was forked with is settled: no more forks.
      await Bun.sleep(SETTLE_MS)
      expect(restarts).toHaveLength(1)
    } finally {
      watch.stop()
    }
  })

  test("re-forks again when the session is replaced or signs out", async () => {
    let fingerprint: string | undefined = "https://cp.example.com\nclient-token"
    let restarts = 0
    const watch = watchControlPlaneSession({
      fingerprint: () => fingerprint,
      restart: async () => {
        restarts += 1
      },
      intervalMs: TICK_MS,
      onError: (error) => {
        throw error
      },
    })
    try {
      fingerprint = "https://cp.example.com\nrotated-token"
      await Bun.sleep(SETTLE_MS)
      expect(restarts).toBe(1)
      expect(watch.applied()).toBe("https://cp.example.com\nrotated-token")

      fingerprint = undefined
      await Bun.sleep(SETTLE_MS)
      expect(restarts).toBe(2)
      expect(watch.applied()).toBeUndefined()
    } finally {
      watch.stop()
    }
  })

  test("retries a failed restart instead of recording it as applied", async () => {
    let fingerprint = "https://cp.example.com\nclient-token"
    const errors: unknown[] = []
    let attempts = 0
    const watch = watchControlPlaneSession({
      fingerprint: () => fingerprint,
      restart: async () => {
        attempts += 1
        if (attempts < 3) throw new Error("sidecar did not start")
      },
      intervalMs: TICK_MS,
      onError: (error) => errors.push(error),
    })
    try {
      fingerprint = "https://cp.example.com\nrotated-token"
      await Bun.sleep(SETTLE_MS)
      expect(attempts).toBe(3)
      expect(errors).toHaveLength(2)
      expect(watch.applied()).toBe("https://cp.example.com\nrotated-token")
    } finally {
      watch.stop()
    }
  })

  test("keeps one restart in flight", async () => {
    let fingerprint = "https://cp.example.com\nclient-token"
    const gate = deferred()
    let restarts = 0
    const watch = watchControlPlaneSession({
      fingerprint: () => fingerprint,
      restart: async () => {
        restarts += 1
        await gate.promise
      },
      intervalMs: TICK_MS,
      onError: (error) => {
        throw error
      },
    })
    try {
      fingerprint = "https://cp.example.com\nrotated-token"
      await Bun.sleep(SETTLE_MS)
      expect(restarts).toBe(1)

      gate.resolve()
      fingerprint = "https://cp.example.com\nsecond-token"
      await Bun.sleep(SETTLE_MS)
      expect(restarts).toBe(2)
      expect(watch.applied()).toBe("https://cp.example.com\nsecond-token")
    } finally {
      watch.stop()
    }
  })

  test("syncs on demand without waiting for a tick", async () => {
    let fingerprint = "https://cp.example.com\nclient-token"
    let restarts = 0
    const watch = watchControlPlaneSession({
      fingerprint: () => fingerprint,
      restart: async () => {
        restarts += 1
      },
      // Long enough that any restart has to come from the explicit call.
      intervalMs: 60_000,
      onError: (error) => {
        throw error
      },
    })
    try {
      await watch.sync()
      expect(restarts).toBe(0)

      fingerprint = "https://cp.example.com\nrotated-token"
      await watch.sync()
      expect(restarts).toBe(1)
      expect(watch.applied()).toBe("https://cp.example.com\nrotated-token")

      await watch.sync()
      expect(restarts).toBe(1)
    } finally {
      watch.stop()
    }
  })

  test("stops watching when stopped", async () => {
    let fingerprint = "https://cp.example.com\nclient-token"
    let restarts = 0
    const watch = watchControlPlaneSession({
      fingerprint: () => fingerprint,
      restart: async () => {
        restarts += 1
      },
      intervalMs: TICK_MS,
      onError: (error) => {
        throw error
      },
    })
    watch.stop()
    fingerprint = "https://cp.example.com\nrotated-token"
    await Bun.sleep(SETTLE_MS)
    expect(restarts).toBe(0)
  })
})
