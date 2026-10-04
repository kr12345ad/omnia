import { describe, expect, test } from "bun:test"
import { createOmniaOperations } from "./operations"
import { createOmniaDriverRegistry } from "./registry"
import type { OmniaDriver, OmniaTargetReference } from "./types"

const target: OmniaTargetReference = {
  elementId: "button-save",
  generation: 4,
  observationId: "observation-1",
}

function createDriver(overrides: Partial<OmniaDriver> = {}): OmniaDriver {
  return {
    id: "native-test",
    backend: "accessibility",
    ...overrides,
  }
}

describe("Omnia operations", () => {
  test("reports no driver instead of claiming platform support", async () => {
    const operations = createOmniaOperations(createOmniaDriverRegistry("linux"))
    expect(await operations.getCapabilities()).toEqual({
      ok: false,
      status: "unavailable",
      reason: "driver_unavailable",
    })
    expect(await operations.observe({ includeElements: true, includeScreenshot: false })).toEqual({
      ok: false,
      status: "unavailable",
      reason: "driver_unavailable",
    })
  })

  test("derives operation availability from registered driver methods", async () => {
    const registry = createOmniaDriverRegistry("linux")
    registry.register(
      createDriver({
        observe: async () => ({ id: "observation-1", timestamp: 1, elements: [] }),
        revalidateTarget: async () => ({ ok: true, status: "ok", value: target }),
        execute: async () => ({ success: true, status: "success" }),
      }),
    )
    expect(await createOmniaOperations(registry).getCapabilities()).toEqual({
      ok: true,
      status: "ok",
      value: {
        id: "native-test",
        backend: "accessibility",
        platform: "linux",
        available: true,
        computer: null,
        operations: { observe: true, find: false, execute: true, subscribe: false },
        capabilities: [],
      },
    })
  })

  test("revalidates the requested target immediately before execute", async () => {
    const calls: string[] = []
    const registry = createOmniaDriverRegistry("linux")
    registry.register(
      createDriver({
        revalidateTarget: async (value) => {
          calls.push(`validate:${value.elementId}`)
          return { ok: true, status: "ok", value: target }
        },
        execute: async (action) => {
          calls.push(
            `execute:${typeof action.target === "object" && action.target?.kind === "element" ? action.target.elementId : "invalid"}`,
          )
          return { success: true, status: "success" }
        },
      }),
    )

    const result = await createOmniaOperations(registry).execute({
      target,
      action: { type: "click", button: "left", count: 1 },
    })
    expect(result.status).toBe("ok")
    expect(calls).toEqual(["validate:button-save", "execute:button-save"])
  })

  test("blocks stale targets before execute", async () => {
    let executed = false
    const registry = createOmniaDriverRegistry("linux")
    registry.register(
      createDriver({
        revalidateTarget: async () => ({ ok: true, status: "ok", value: { ...target, generation: 5 } }),
        execute: async () => {
          executed = true
          return { success: true, status: "success" }
        },
      }),
    )

    const result = await createOmniaOperations(registry).execute({
      target,
      action: { type: "focus" },
    })
    expect(result).toEqual({ ok: false, status: "blocked", reason: "target_stale" })
    expect(executed).toBe(false)
  })

  test("returns structured permission failures before invoking the driver", async () => {
    let observed = false
    const registry = createOmniaDriverRegistry("linux")
    registry.register(
      createDriver({
        capabilities: [
          {
            capability: "observe",
            status: "available",
            permissions: [
              {
                id: "accessibility",
                description: "Accessibility access",
                status: "prompt",
                capabilities: ["observe"],
                promptable: true,
              },
            ],
          },
        ],
        observe: async () => {
          observed = true
          return { id: "observation-1", timestamp: 1, elements: [] }
        },
      }),
    )
    expect(
      await createOmniaOperations(registry).observe({
        includeElements: true,
        includeScreenshot: false,
      }),
    ).toEqual({
      ok: false,
      status: "permission_required",
      permission: "accessibility",
      canRequest: true,
    })
    expect(observed).toBe(false)
  })

  test("blocks a permission that is not granted for a required capability", async () => {
    let executed = false
    const registry = createOmniaDriverRegistry("linux")
    registry.register(
      createDriver({
        capabilities: [
          {
            capability: "pointer",
            status: "available",
            permissions: [
              {
                id: "computer.input",
                description: "Send pointer input",
                status: "denied",
                capabilities: ["pointer"],
              },
            ],
          },
        ],
        revalidateTarget: async () => ({ ok: true, status: "ok", value: target }),
        execute: async () => {
          executed = true
          return { success: true, status: "success" }
        },
      }),
    )

    expect(await createOmniaOperations(registry).execute({ target, action: { type: "click" } })).toEqual({
      ok: false,
      status: "permission_required",
      permission: "computer.input",
      canRequest: false,
    })
    expect(executed).toBe(false)
  })

  test("runs the action when every required capability is granted", async () => {
    const registry = createOmniaDriverRegistry("linux")
    registry.register(
      createDriver({
        capabilities: [
          {
            capability: "pointer",
            status: "available",
            permissions: [
              {
                id: "computer.input",
                description: "Send pointer input",
                status: "granted",
                capabilities: ["pointer"],
              },
            ],
          },
        ],
        revalidateTarget: async () => ({ ok: true, status: "ok", value: target }),
        execute: async () => ({ success: true, status: "success" }),
      }),
    )

    expect((await createOmniaOperations(registry).execute({ target, action: { type: "click" } })).status).toBe("ok")
  })

  test("blocks a revalidated reference whose role no longer matches", async () => {
    let executed = false
    const registry = createOmniaDriverRegistry("linux")
    registry.register(
      createDriver({
        revalidateTarget: async () => ({
          ok: true,
          status: "ok",
          value: { ...target, role: "textbox" },
        }),
        execute: async () => {
          executed = true
          return { success: true, status: "success" }
        },
      }),
    )

    expect(
      await createOmniaOperations(registry).execute({
        target: { ...target, role: "button" },
        action: { type: "focus" },
      }),
    ).toEqual({ ok: false, status: "blocked", reason: "target_stale" })
    expect(executed).toBe(false)
  })

  test("blocks an expired reference before the driver is consulted", async () => {
    let revalidated = false
    const registry = createOmniaDriverRegistry("linux")
    registry.register(
      createDriver({
        revalidateTarget: async () => {
          revalidated = true
          return { ok: true, status: "ok", value: target }
        },
        execute: async () => ({ success: true, status: "success" }),
      }),
    )

    expect(
      await createOmniaOperations(registry).execute({
        target: { ...target, expiresAt: Date.now() - 1 },
        action: { type: "focus" },
      }),
    ).toEqual({ ok: false, status: "blocked", reason: "target_stale" })
    expect(revalidated).toBe(false)
  })
})
