import { describe, expect, test } from "bun:test"
import { CuaLiveView, LIVE_VIEW_CAPABILITY } from "./live-view"
import { CuaEngine } from "./engine"
import { CuaHostDriver } from "./host-driver"
import { EntitlementGate, isEntitlementRefusedError } from "./entitlements"
import type { CuaBackend, CuaCapabilities, CuaSnapshot } from "./types"
import type { ActionResult } from "../protocol"

// A fresh Response per call: a Response body can only be read once, so a
// shared instance would make the second check look like an unreadable answer.
const ALLOW = () =>
  new Response(
    JSON.stringify({
      ok: true,
      allowed: true,
      code: "granted",
      plan: "free",
      capability: LIVE_VIEW_CAPABILITY,
      used: 1,
      limit: 20,
      metering: "soft",
      reason: "live_view is included in the free plan.",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

const REFUSE = () =>
  new Response(
    JSON.stringify({
      ok: false,
      allowed: false,
      code: "not_entitled",
      plan: "free",
      capability: LIVE_VIEW_CAPABILITY,
      used: 0,
      limit: 0,
      metering: "hard",
      reason: "live_view is not included in the free plan.",
    }),
    { status: 402, headers: { "content-type": "application/json" } },
  )

function countingGate(response: () => Response | Promise<Response>): { gate: EntitlementGate; calls: string[] } {
  const calls: string[] = []
  const http = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(String((JSON.parse(String(init?.body ?? "{}")) as { capability?: string }).capability))
    return response()
  }) as unknown as typeof fetch
  return { calls, gate: new EntitlementGate({ env: { OMNIA_SERVER_URL: "http://control.test", OMNIA_SERVER_TOKEN: "t" }, authFile: "/nonexistent/auth.json", http }) }
}

function frame(index: number): ActionResult & { path?: string } {
  return { success: true, status: "success", message: `frame ${index}`, metadata: { path: `/tmp/frame-${index}.png` } }
}

describe("live view metering", () => {
  test("a stream costs one unit no matter how many frames it delivers", async () => {
    const harness = countingGate(ALLOW)
    let captures = 0
    const view = await CuaLiveView.open(async () => frame(captures++), { gate: harness.gate, now: () => 1000 })
    for (let index = 0; index < 25; index += 1) await view.frame()
    expect(captures).toBe(25)
    expect(view.frameCount).toBe(25)
    expect(harness.calls).toEqual([LIVE_VIEW_CAPABILITY])
    view.close()
  })

  test("each new stream spends its own unit", async () => {
    const harness = countingGate(ALLOW)
    for (let index = 0; index < 3; index += 1) {
      const view = await CuaLiveView.open(async () => frame(index), { gate: harness.gate })
      await view.frame()
      view.close()
    }
    expect(harness.calls).toHaveLength(3)
  })

  test("a refused stream throws before a single frame is captured", async () => {
    const harness = countingGate(REFUSE)
    let captures = 0
    const thrown = await CuaLiveView.open(async () => frame(captures++), { gate: harness.gate }).catch(
      (error: unknown) => error,
    )
    expect(isEntitlementRefusedError(thrown)).toBe(true)
    if (!isEntitlementRefusedError(thrown)) throw new Error("expected a typed refusal")
    expect(thrown.capability).toBe(LIVE_VIEW_CAPABILITY)
    expect(thrown.decision.code).toBe("not_entitled")
    expect(thrown.decision.reason).toContain("not included in the free plan")
    expect(captures).toBe(0)
  })

  test("live_view is free-tier soft, so an unreachable control plane still streams", async () => {
    const calls: string[] = []
    const gate = new EntitlementGate({
      env: { OMNIA_SERVER_URL: "http://control.test", OMNIA_SERVER_TOKEN: "t" },
      authFile: "/nonexistent/auth.json",
      http: (async () => {
        calls.push("asked")
        throw new Error("ECONNREFUSED")
      }) as unknown as typeof fetch,
    })
    const view = await CuaLiveView.open(async () => frame(0), { gate })
    expect(view.decision.origin).toBe("fail-open")
    expect((await view.frame()).result.success).toBe(true)
    // The outage fallback is cached, so the frame loop adds no more round trips.
    await view.frame()
    expect(calls).toHaveLength(1)
  })

  test("a closed stream refuses to capture another frame", async () => {
    const harness = countingGate(ALLOW)
    const view = await CuaLiveView.open(async () => frame(0), { gate: harness.gate })
    view.close()
    expect(view.isClosed).toBe(true)
    await expect(view.frame()).rejects.toThrow("closed")
  })
})

function stubBackend(): CuaBackend {
  const snapshot: CuaSnapshot = {
    id: "snap-live",
    generation: 1,
    takenAt: 0,
    platform: "linux",
    windows: [],
    elements: [],
    truncated: false,
    warnings: [],
  }
  const capabilities: CuaCapabilities = {
    snapshot: true,
    semanticActions: false,
    backgroundActions: false,
    backgroundInput: false,
    pointer: false,
    keyboard: false,
    clipboard: false,
    screenshot: true,
    windowManagement: false,
    waitFor: false,
    refs: true,
    actions: [],
    limits: [],
  }
  return {
    platform: "linux",
    name: "live-view-stub",
    available: async () => true,
    capabilities: async () => capabilities,
    snapshot: async () => snapshot,
    find: async () => [],
    execute: async (action) => ({ ok: true, action, verified: true, message: "done", delivery: "background-ax", generation: 1 }),
    waitFor: async () => ({ ok: true, waitedMs: 0 }),
    dispose: async () => undefined,
  }
}

describe("driver live view", () => {
  test("the driver's stream captures through the screenshot path on the lease", async () => {
    const harness = countingGate(ALLOW)
    let captures = 0
    const legacy = {
      capabilities: () => [],
      captureScreen: async () => {
        captures += 1
        return frame(captures)
      },
    }
    const driver = new CuaHostDriver({
      engine: new CuaEngine({ backend: stubBackend(), platform: "linux" }),
      legacy: legacy as never,
    })
    const view = await driver.openLiveView({ gate: harness.gate })
    expect(view.capability).toBe(LIVE_VIEW_CAPABILITY)
    for (let index = 0; index < 5; index += 1) await view.frame()
    view.close()
    expect(captures).toBe(5)
    expect(harness.calls).toEqual([LIVE_VIEW_CAPABILITY])
  })

  test("a refused driver stream never reaches the screenshot path", async () => {
    const harness = countingGate(REFUSE)
    let captures = 0
    const driver = new CuaHostDriver({
      engine: new CuaEngine({ backend: stubBackend(), platform: "linux" }),
      legacy: { capabilities: () => [], captureScreen: async () => frame(captures++) } as never,
    })
    await expect(driver.openLiveView({ gate: harness.gate })).rejects.toThrow("live_view")
    expect(captures).toBe(0)
  })

  test("one screenshot action is not a live view and stays unmetered", async () => {
    const harness = countingGate(ALLOW)
    const driver = new CuaHostDriver({
      engine: new CuaEngine({ backend: stubBackend(), platform: "linux" }),
      legacy: {
        capabilities: () => [],
        info: async () => ({ id: "local", name: "local", platform: "linux" }),
        captureScreen: async () => frame(0),
      } as never,
    })
    const result = await driver.execute({ type: "screenshot" })
    expect(result.success).toBe(true)
    expect(harness.calls).toEqual([])
  })
})
