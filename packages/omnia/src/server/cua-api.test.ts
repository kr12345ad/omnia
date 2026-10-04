import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sessionProof } from "./api"
import { startOmniaServer } from "./server"
import type { ServerComputerDriver } from "./computers"
import type { OmniaScope, PermissionState } from "./permissions"
import type {
  CuaAction,
  CuaActionResult,
  CuaCapabilities,
  CuaElement,
  CuaFindQuery,
  CuaSnapshot,
  CuaWaitCondition,
  CuaWaitResult,
} from "../cua/types"
import type { ActionResult, ComputerAction, FindRequest, Observation } from "../protocol"

function cuaCapabilities(): CuaCapabilities {
  return {
    snapshot: true,
    semanticActions: true,
    backgroundActions: true,
    backgroundInput: false,
    pointer: true,
    keyboard: true,
    clipboard: false,
    screenshot: true,
    windowManagement: true,
    waitFor: true,
    refs: true,
    actions: ["invoke", "set_value", "focus", "click", "type", "key", "scroll", "window"],
    limits: [],
  }
}

function cuaElement(): CuaElement {
  return {
    ref: "cua:atspi/export/0",
    backendRef: "atspi:1",
    role: "button",
    name: "Export",
    enabled: true,
    focused: false,
    editable: false,
    actions: ["click"],
    states: ["enabled"],
    bounds: { x: 10, y: 10, width: 100, height: 30 },
    generation: 1,
  }
}

function cuaSnapshot(): CuaSnapshot {
  return {
    id: "cap-1",
    generation: 1,
    takenAt: 1700000000000,
    platform: "linux",
    windows: [
      {
        ref: "cua:window",
        backendRef: "atspi:0",
        app: "Editor",
        title: "Editor Window",
        focused: true,
        generation: 1,
      },
    ],
    elements: [cuaElement()],
    truncated: false,
    warnings: [],
  }
}

interface CuaHarness {
  readonly driver: ServerComputerDriver
  readonly executed: CuaAction[]
  readonly protocolActions: ComputerAction[]
  readonly waits: CuaWaitCondition[]
  readonly snapshots: number
}

function cuaDriver(): CuaHarness {
  const executed: CuaAction[] = []
  const protocolActions: ComputerAction[] = []
  const waits: CuaWaitCondition[] = []
  let snapshots = 0
  const engine = {
    platform: "linux" as const,
    name: "cua-fake",
    available: async () => true,
    capabilities: async () => cuaCapabilities(),
    snapshot: async (): Promise<CuaSnapshot> => {
      snapshots += 1
      return cuaSnapshot()
    },
    find: async (_query: CuaFindQuery): Promise<CuaElement[]> => [cuaElement()],
    execute: async (action: CuaAction): Promise<CuaActionResult> => {
      executed.push(action)
      return { ok: true, action, verified: true, message: "Executed.", delivery: "background-ax", generation: 1 }
    },
    waitFor: async (condition: CuaWaitCondition): Promise<CuaWaitResult> => {
      waits.push(condition)
      return { ok: true, waitedMs: 5, element: cuaElement() }
    },
  }
  const observation: Observation = { id: "obs-1", backend: "cua-fake", elements: [] }
  const driver = {
    id: "cua-computer",
    backend: "linux-at-spi",
    cua: engine,
    capabilities: () => [
      { capability: "cua_snapshot", status: "available" },
      { capability: "cua_refs", status: "available" },
      { capability: "cua_background", status: "available" },
      { capability: "cua_rich_actions", status: "available" },
      { capability: "cua_wait", status: "available" },
    ],
    getInfo: async () => ({ id: "cua-computer", name: "Cua", platform: "linux", backend: "linux-at-spi", connected: true }),
    observe: async () => observation,
    find: async (request: FindRequest) => ({ query: request.query, matches: [] }),
    execute: async (action: ComputerAction): Promise<ActionResult> => {
      protocolActions.push(action)
      return { success: true, status: "success", message: "ok" }
    },
  } as unknown as ServerComputerDriver
  return {
    driver,
    executed,
    protocolActions,
    waits,
    get snapshots() {
      return snapshots
    },
  }
}

function plainDriver(): ServerComputerDriver {
  const observation: Observation = { id: "obs-1", backend: "plain", elements: [] }
  return {
    id: "plain-computer",
    backend: "plain",
    capabilities: () => [],
    getInfo: async () => ({ id: "plain-computer", name: "Plain", platform: "linux", backend: "plain", connected: true }),
    observe: async () => observation,
    find: async (request: FindRequest) => ({ query: request.query, matches: [] }),
    execute: async (_action: ComputerAction): Promise<ActionResult> => ({ success: true, status: "success", message: "ok" }),
  } as unknown as ServerComputerDriver
}

async function withServer<T>(
  driver: ServerComputerDriver,
  fn: (server: Awaited<ReturnType<typeof startOmniaServer>>) => Promise<T>,
  permissions?: Partial<Record<OmniaScope, PermissionState>>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "omnia-cua-api-"))
  const server = await startOmniaServer({
    drivers: [driver],
    credentialsFile: join(dir, "credentials.json"),
    authFile: join(dir, "auth.json"),
    superskillFile: join(dir, "superskills.json"),
    memoryFile: join(dir, "memories.json"),
    computerUseFile: join(dir, "computer-use.json"),
    ...(permissions === undefined ? {} : { permissions }),
  })
  try {
    return await fn(server)
  } finally {
    await server.stop()
  }
}

function caller(server: { url: string; token: string }) {
  return async (path: string, body: Record<string, unknown> | undefined) => {
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined
    const response = await fetch(`${server.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
        ...(sessionId === undefined ? {} : { "x-omnia-session-proof": sessionProof(server.token, sessionId) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const parsed = (await response.json()) as Record<string, unknown>
    return { status: response.status, body: parsed }
  }
}

describe("cua api routes", () => {
  test("snapshot requires approval when UI_READ is prompt and works with approve:true", async () => {
    const harness = cuaDriver()
    await withServer(
      harness.driver,
      async (server) => {
        const call = caller(server)
        const denied = await call("/v1/computers/cua-computer/cua/snapshot", { sessionId: "session-1" })
        expect(denied.status).toBe(428)
        expect((denied.body.result as { error?: { code?: string } })?.error?.code).toBe("permission_required")

        const approved = await call("/v1/computers/cua-computer/cua/snapshot", {
          sessionId: "session-1",
          approve: true,
          approvedBy: "test",
          approvedScopes: ["UI_READ"],
        })
        expect(approved.status).toBe(200)
        expect(approved.body.ok).toBe(true)
        const snapshot = approved.body.snapshot as CuaSnapshot
        expect(snapshot.id).toBe("cap-1")
        expect(snapshot.elements[0]?.ref).toBe("cua:atspi/export/0")
        expect(harness.snapshots).toBe(1)
      },
      { UI_READ: "prompt" },
    )
  })

  test("find resolves the query through the cua backend", async () => {
    const harness = cuaDriver()
    await withServer(harness.driver, async (server) => {
      const found = await caller(server)("/v1/computers/cua-computer/cua/find", { query: "Export" })
      expect(found.status).toBe(200)
      expect(found.body.ok).toBe(true)
      const elements = found.body.elements as CuaElement[]
      expect(elements).toHaveLength(1)
      expect(elements[0]?.ref).toBe("cua:atspi/export/0")
    })
  })

  test("act maps the HTTP action to the engine and enforces permissions", async () => {
    const harness = cuaDriver()
    await withServer(harness.driver, async (server) => {
      const call = caller(server)
      const denied = await call("/v1/computers/cua-computer/cua/act", {
        action: { type: "invoke", ref: "cua:atspi/export/0" },
        sessionId: "session-1",
      })
      expect(denied.status).toBe(428)
      expect(harness.executed).toHaveLength(0)

      const acted = await call("/v1/computers/cua-computer/cua/act", {
        action: { type: "invoke", ref: "cua:atspi/export/0", action: "click" },
        sessionId: "session-1",
        approve: true,
        approvedBy: "test",
        approvedScopes: ["UI_CONTROL"],
      })
      expect(acted.status).toBe(200)
      expect(acted.body.ok).toBe(true)
      expect(harness.executed).toEqual([{ type: "invoke", ref: "cua:atspi/export/0", action: "click" }])
      const result = acted.body.result as { ok: boolean; delivery?: string; engine?: string }
      expect(result.ok).toBe(true)
    })
  })

  test("wait evaluates the condition through the engine", async () => {
    const harness = cuaDriver()
    await withServer(harness.driver, async (server) => {
      const waited = await caller(server)("/v1/computers/cua-computer/cua/wait", {
        condition: { ref: "cua:atspi/export/0", timeoutMs: 100 },
      })
      expect(waited.status).toBe(200)
      expect(waited.body.ok).toBe(true)
      expect((waited.body.result as CuaWaitResult).waitedMs).toBe(5)
      expect(harness.waits).toEqual([{ ref: "cua:atspi/export/0", timeoutMs: 100 }])
    })
  })

  test("returns 501 cua_unavailable when the driver has no cua surface", async () => {
    await withServer(plainDriver(), async (server) => {
      const response = await caller(server)("/v1/computers/plain-computer/cua/snapshot", {})
      expect(response.status).toBe(501)
      expect(response.body.ok).toBe(false)
      expect((response.body.error as { code?: string })?.code).toBe("cua_unavailable")
    })
  })
})

describe("computer-use status cua info", () => {
  test("reports cua availability, backend, and capability names", async () => {
    const harness = cuaDriver()
    await withServer(harness.driver, async (server) => {
      const response = await caller(server)("/v1/computer-use/status", undefined)
      expect(response.status).toBe(200)
      const status = response.body.status as { cua?: { available: boolean; backend?: string; capabilities: string[] } }
      expect(status.cua).toBeDefined()
      expect(status.cua?.available).toBe(true)
      expect(status.cua?.backend).toBe("cua-fake")
      expect(status.cua?.capabilities).toContain("cua_snapshot")
      expect(status.cua?.capabilities).toContain("cua_wait")
    })
  })

  test("omits cua when the driver has no cua surface", async () => {
    await withServer(plainDriver(), async (server) => {
      const response = await caller(server)("/v1/computer-use/status", undefined)
      expect(response.status).toBe(200)
      const status = response.body.status as { cua?: unknown }
      expect(status.cua).toBeUndefined()
    })
  })
})

describe("window management actions", () => {
  test("tile, maximize, and close resolve through the cua engine", async () => {
    const harness = cuaDriver()
    await withServer(harness.driver, async (server) => {
      const post = caller(server)
      const cases = [
        ["window_tile", { text: "right" }, { type: "window", action: "tile", position: "right" }],
        ["window_maximize", {}, { type: "window", action: "maximize" }],
        ["window_move", { x: 40, y: 60 }, { type: "window", action: "move", x: 40, y: 60 }],
        ["window_close", {}, { type: "window", action: "close" }],
      ] as const
      for (const [action, extra, expected] of cases) {
        const response = await post("/v1/computers/cua-computer/actions", {
          action,
          target: { elementId: "cua:window" },
          ...extra,
          approve: true,
          approvedBy: "test",
          approvedScopes: ["UI_CONTROL", "PROCESS_EXECUTE"],
        })
        expect(response.status).toBe(200)
        expect(harness.executed.at(-1)).toMatchObject(expected)
      }
    })
  })

  test("rejects unknown window actions with 400 instead of falling through to close", async () => {
    const harness = cuaDriver()
    await withServer(harness.driver, async (server) => {
      const response = await caller(server)("/v1/computers/cua-computer/actions", {
        action: "window_bogus",
        target: { elementId: "cua:window" },
        approve: true,
        approvedBy: "test",
        approvedScopes: ["UI_CONTROL", "PROCESS_EXECUTE"],
      })
      expect(response.status).toBe(400)
      expect(harness.executed).toHaveLength(0)
    })
  })

  test("rejects a caller elementId that is not in the fresh snapshot", async () => {
    const harness = cuaDriver()
    await withServer(harness.driver, async (server) => {
      const response = await caller(server)("/v1/computers/cua-computer/actions", {
        action: "window_maximize",
        target: { elementId: "forged:window" },
        approve: true,
        approvedBy: "test",
        approvedScopes: ["UI_CONTROL"],
      })
      expect(response.status).toBe(404)
      const result = response.body.result as { error?: { code?: string } }
      expect(result.error?.code).toBe("window_not_found")
      expect(harness.executed).toHaveLength(0)
    })
  })

  test("window_close requires PROCESS_EXECUTE, not UI_CONTROL alone", async () => {
    const harness = cuaDriver()
    await withServer(harness.driver, async (server) => {
      const response = await caller(server)("/v1/computers/cua-computer/actions", {
        action: "window_close",
        target: { elementId: "cua:window" },
        approve: true,
        approvedBy: "test",
        approvedScopes: ["UI_CONTROL"],
      })
      expect(response.status).toBe(428)
      expect(harness.executed).toHaveLength(0)
    })
  })
})

describe("batch window and calibration steps", () => {
  test("window_* steps in a plan resolve the window fragment and keep per-step results", async () => {
    const harness = cuaDriver()
    await withServer(harness.driver, async (server) => {
      const response = await caller(server)("/v1/computers/cua-computer/do", {
        approve: true,
        approvedBy: "test",
        approvedScopes: ["UI_CONTROL"],
        steps: [
          { action: "window_minimize", window: "Editor" },
          { action: "window_maximize", target: { elementId: "cua:window" } },
          { action: "window_tile", window: "Editor Window", text: "right" },
        ],
      })
      expect(response.status).toBe(200)
      expect(response.body.ok).toBe(true)
      const result = response.body.result as {
        success: boolean
        completed: number
        total: number
        steps: Array<{ index: number; action: string; success: boolean; message?: string; verification?: { status: string } }>
      }
      expect(result.completed).toBe(3)
      expect(result.steps.map((step) => step.action)).toEqual(["window_minimize", "window_maximize", "window_tile"])
      expect(result.steps.every((step) => step.success)).toBe(true)
      expect(result.steps[0]?.verification?.status).toBe("verified")
      expect(harness.executed).toEqual([
        { type: "window", action: "minimize", ref: "cua:window" },
        { type: "window", action: "maximize", ref: "cua:window" },
        { type: "window", action: "tile", ref: "cua:window", position: "right" },
      ])
    })
  })

  test("a window step without approval is rejected per step and stops the plan", async () => {
    const harness = cuaDriver()
    await withServer(harness.driver, async (server) => {
      const response = await caller(server)("/v1/computers/cua-computer/do", {
        steps: [
          { action: "window_minimize", window: "Editor" },
          { action: "window_maximize", target: { elementId: "cua:window" } },
        ],
      })
      expect(response.body.ok).toBe(false)
      const result = response.body.result as {
        failedAt?: number
        steps: Array<{ success: boolean; error?: { code?: string } }>
      }
      expect(result.failedAt).toBe(0)
      expect(result.steps).toHaveLength(1)
      expect(result.steps[0]?.success).toBe(false)
      expect(result.steps[0]?.error?.code).toBe("permission_required")
      expect(harness.executed).toHaveLength(0)
    })
  })

  test("a forged window elementId in a plan is rejected against the fresh snapshot", async () => {
    const harness = cuaDriver()
    await withServer(harness.driver, async (server) => {
      const response = await caller(server)("/v1/computers/cua-computer/do", {
        approve: true,
        approvedBy: "test",
        approvedScopes: ["UI_CONTROL"],
        steps: [{ action: "window_maximize", target: { elementId: "forged:window" } }],
      })
      const result = response.body.result as {
        failedAt?: number
        steps: Array<{ success: boolean; error?: { code?: string } }>
      }
      expect(response.body.ok).toBe(false)
      expect(result.failedAt).toBe(0)
      expect(result.steps[0]?.error?.code).toBe("window_not_found")
      expect(harness.executed).toHaveLength(0)
    })
  })

  test("calibration_* steps in a plan invoke the calibration handler", async () => {
    const harness = cuaDriver()
    await withServer(harness.driver, async (server) => {
      const response = await caller(server)("/v1/computers/cua-computer/do", {
        approve: true,
        approvedBy: "test",
        approvedScopes: ["UI_READ"],
        steps: [{ action: "calibration_start" }, { action: "calibration_status" }],
      })
      expect(response.status).toBe(200)
      expect(response.body.ok).toBe(true)
      const result = response.body.result as {
        completed: number
        steps: Array<{ action: string; success: boolean; message?: string }>
      }
      expect(result.completed).toBe(2)
      expect(result.steps[0]?.message).toContain("Calibration started")
      expect(result.steps[1]?.success).toBe(true)
      expect(result.steps[1]?.message).toContain("alibrat")
    })
  })
})

describe("cua dismiss action", () => {
  test("dismiss needs UI_CONTROL and reaches the engine", async () => {
    const harness = cuaDriver()
    await withServer(harness.driver, async (server) => {
      const call = caller(server)
      const denied = await call("/v1/computers/cua-computer/cua/act", {
        action: { type: "dismiss" },
        sessionId: "session-1",
      })
      expect(denied.status).toBe(428)
      expect(harness.executed).toHaveLength(0)

      const acted = await call("/v1/computers/cua-computer/cua/act", {
        action: { type: "dismiss" },
        sessionId: "session-1",
        approve: true,
        approvedBy: "test",
        approvedScopes: ["UI_CONTROL"],
      })
      expect(acted.status).toBe(200)
      expect(harness.executed).toEqual([{ type: "dismiss" }])
    })
  })
})

describe("rich actions on the standard action surface", () => {
  test("accepts rich accessibility actions through /actions", async () => {
    const harness = cuaDriver()
    await withServer(harness.driver, async (server) => {
      const post = caller(server)
      for (const action of [
        "toggle",
        "select",
        "expand",
        "collapse",
        "increment",
        "decrement",
        "scroll_into_view",
      ]) {
        const response = await post("/v1/computers/cua-computer/actions", {
          action,
          target: { elementId: "cua:atspi/export/0" },
          approve: true,
          approvedBy: "test",
          approvedScopes: ["UI_CONTROL", "KEYBOARD", "POINTER"],
        })
        expect(response.status).toBe(200)
      }
    })
    expect(harness.protocolActions.map((action) => action.type)).toEqual([
      "toggle",
      "select",
      "expand",
      "collapse",
      "increment",
      "decrement",
      "scroll_into_view",
    ])
  })
})
