import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sessionProof } from "./api"
import { startOmniaServer } from "./server"
import { readComputerUseTrail, type ComputerUseRecord } from "../security/journal"
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

// /cua/act reaches the Cua engine driver directly, so the ComputerManager
// boundary that journals every other computer-use action never sees it. These
// tests pin the trail for that route: an action that landed on the desktop is
// recorded with the same fields an /actions action is recorded with.

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

// The engine answers with the snapshot it read after the action, which is what
// the journal resolves the aim point and the generation from.
function cuaSnapshot(): CuaSnapshot {
  return {
    id: "cap-1",
    generation: 1,
    takenAt: 1700000000000,
    platform: "linux",
    windows: [
      { ref: "cua:window", backendRef: "atspi:0", app: "Editor", title: "Editor Window", focused: true, generation: 1 },
    ],
    elements: [cuaElement()],
    truncated: false,
    warnings: [],
  }
}

interface CuaHarness {
  readonly driver: ServerComputerDriver
  readonly executed: CuaAction[]
}

function cuaDriver(): CuaHarness {
  const executed: CuaAction[] = []
  const engine = {
    platform: "linux" as const,
    name: "cua-fake",
    available: async () => true,
    capabilities: async () => cuaCapabilities(),
    snapshot: async (): Promise<CuaSnapshot> => cuaSnapshot(),
    find: async (_query: CuaFindQuery): Promise<CuaElement[]> => [cuaElement()],
    execute: async (action: CuaAction): Promise<CuaActionResult> => {
      executed.push(action)
      return {
        ok: true,
        action,
        verified: true,
        message: "Executed.",
        delivery: "background-ax",
        generation: 1,
        observation: cuaSnapshot(),
      }
    },
    waitFor: async (condition: CuaWaitCondition): Promise<CuaWaitResult> => ({ ok: true, waitedMs: 5, element: cuaElement() }),
  }
  const observation: Observation = { id: "obs-1", backend: "cua-fake", elements: [] }
  const driver = {
    id: "cua-computer",
    backend: "linux-at-spi",
    cua: engine,
    capabilities: () => [{ capability: "cua_snapshot", status: "available" }],
    getInfo: async () => ({ id: "cua-computer", name: "Cua", platform: "linux", backend: "linux-at-spi", connected: true }),
    observe: async () => observation,
    find: async (request: FindRequest) => ({ query: request.query, matches: [] }),
    execute: async (action: ComputerAction): Promise<ActionResult> => ({ success: true, status: "success", message: "ok" }),
  } as unknown as ServerComputerDriver
  return { driver, executed }
}

interface CuaServer {
  readonly url: string
  readonly token: string
  readonly auditFile: string
  readonly stop: () => Promise<void>
}

async function withServer(
  harness: CuaHarness,
  permissions?: Partial<Record<OmniaScope, PermissionState>>,
): Promise<CuaServer> {
  const dir = mkdtempSync(join(tmpdir(), "omnia-cua-journal-"))
  const auditFile = join(dir, "computer-use.jsonl")
  const server = await startOmniaServer({
    drivers: [harness.driver],
    credentialsFile: join(dir, "credentials.json"),
    authFile: join(dir, "auth.json"),
    superskillFile: join(dir, "superskills.json"),
    memoryFile: join(dir, "memories.json"),
    computerUseFile: join(dir, "computer-use.json"),
    computerUseAuditFile: auditFile,
    ...(permissions === undefined ? {} : { permissions }),
  })
  return { url: server.url, token: server.token, auditFile, stop: () => server.stop() }
}

function caller(server: CuaServer) {
  return async (path: string, body: Record<string, unknown>) => {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined
    const response = await fetch(`${server.url}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
        "x-omnia-origin": "agent",
        ...(sessionId === undefined ? {} : { "x-omnia-session-proof": sessionProof(server.token, sessionId) }),
      },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
}

function records(auditFile: string): readonly ComputerUseRecord[] {
  return readComputerUseTrail(auditFile).records
}

function latestRecord(auditFile: string): ComputerUseRecord {
  const record = records(auditFile).at(-1)
  if (record === undefined) throw new Error("the computer-use audit journal holds no records")
  return record
}

describe("cua act audit journal", () => {
  test("an action that reaches the cua engine is journaled with every field an /actions action carries", async () => {
    const harness = cuaDriver()
    const server = await withServer(harness, { UI_CONTROL: "granted" })
    try {
      const acted = await caller(server)("/v1/computers/cua-computer/cua/act", {
        action: { type: "invoke", ref: "cua:atspi/export/0", action: "click", observationId: "cap-1", generation: 1 },
        sessionId: "session-1",
        approvedBy: "audit-test",
      })
      expect(acted.status).toBe(200)
      expect(harness.executed).toHaveLength(1)

      const trail = readComputerUseTrail(server.auditFile)
      expect(trail.chain).toBe("ok")
      expect(records(server.auditFile)).toHaveLength(1)
      const record = latestRecord(server.auditFile)
      expect(record.type).toBe("computer_use.action")
      expect(record.computerId).toBe("cua-computer")
      expect(record.action).toBe("invoke")
      // The ref, the observation it came from, and the generation it was bound to.
      expect(record.ref).toBe("cua:atspi/export/0")
      expect(record.observationId).toBe("cap-1")
      expect(record.generation).toBe(1)
      expect(record.target).toBe("Export")
      // The aim is resolved from the element's own metadata, so the strategy
      // names the evidence the point came from.
      expect(record.aim).toEqual({ x: 60, y: 25, strategy: "control-center" })
      // The permission decision, and the verdict the engine reported.
      expect(record.permission.allowed).toBe(true)
      expect(record.permission.status).toBe("allowed")
      expect(record.permission.by).toBe("audit-test")
      expect(record.permission.scopes).toContain("UI_CONTROL")
      expect(record.result.status).toBe("verified")
      expect(record.result.method).toBe("background-ax")
    } finally {
      await server.stop()
      rmSync(join(server.auditFile, ".."), { recursive: true, force: true })
    }
  })

  test("a refused act journals the permission decision instead of an action that happened", async () => {
    const harness = cuaDriver()
    const server = await withServer(harness, { UI_CONTROL: "prompt" })
    try {
      const refused = await caller(server)("/v1/computers/cua-computer/cua/act", {
        action: { type: "invoke", ref: "cua:atspi/export/0" },
        sessionId: "session-1",
      })
      expect(refused.status).toBe(428)
      expect(harness.executed).toHaveLength(0)

      const record = latestRecord(server.auditFile)
      expect(record.action).toBe("invoke")
      expect(record.ref).toBe("cua:atspi/export/0")
      expect(record.permission.allowed).toBe(false)
      expect(record.permission.status).toBe("prompt")
      expect(record.permission.scopes).toContain("UI_CONTROL")
      expect(record.result.status).toBe("not_verified")
      expect(record.aim).toBeUndefined()
      expect(readComputerUseTrail(server.auditFile).chain).toBe("ok")
    } finally {
      await server.stop()
      rmSync(join(server.auditFile, ".."), { recursive: true, force: true })
    }
  })

  test("a pointer click journals its pixel aim, and every act appends to the same chain", async () => {
    const harness = cuaDriver()
    const server = await withServer(harness, { UI_CONTROL: "prompt" })
    try {
      const post = caller(server)
      const acted = await post("/v1/computers/cua-computer/cua/act", {
        action: { type: "click", point: { x: 812, y: 481 }, button: "left" },
        sessionId: "session-1",
        approve: true,
        approvedBy: "audit-test",
        approvedScopes: ["UI_CONTROL"],
      })
      expect(acted.status).toBe(200)

      const dismissed = await post("/v1/computers/cua-computer/cua/act", {
        action: { type: "dismiss" },
        sessionId: "session-1",
        approve: true,
        approvedBy: "audit-test",
        approvedScopes: ["UI_CONTROL"],
      })
      expect(dismissed.status).toBe(200)
      expect(harness.executed).toHaveLength(2)

      const trail = readComputerUseTrail(server.auditFile)
      expect(trail.chain).toBe("ok")
      expect(trail.records).toHaveLength(2)
      const [click, dismiss] = trail.records
      expect(click!.action).toBe("click")
      expect(click!.ref).toBeUndefined()
      // Pixel coordinates are for canvas/unknown surfaces only, and are recorded
      // as what they are instead of being dressed up as a resolved control.
      expect(click!.aim).toEqual({ x: 812, y: 481, strategy: "pixel" })
      expect(click!.permission.by).toBe("audit-test")
      expect(click!.result.status).toBe("verified")
      expect(dismiss!.action).toBe("dismiss")
      expect(dismiss!.aim).toBeUndefined()
      expect(dismiss!.permission.allowed).toBe(true)
    } finally {
      await server.stop()
      rmSync(join(server.auditFile, ".."), { recursive: true, force: true })
    }
  })
})
