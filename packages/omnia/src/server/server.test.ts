import { describe, expect, test } from "bun:test"
import { startOmniaServer } from "./server"
import { sessionProof } from "./api"
import { OMNIA_ACTION_CATALOG } from "./catalog"
import { sliceTypeText } from "./computers"
import { parseActionScript, renderToolSchemas } from "./text-protocol"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserController, ServerComputerDriver } from "./computers"
import type { ActionResult, ComputerAction, Observation } from "../protocol"

function createFakeDriver(): ServerComputerDriver & { rename: (name: string) => void; lastAction: () => ComputerAction | undefined } {
  let observations = 0
  let dialogOpen = false
  let focusedWindow = "x11:0x1"
  let typed = ""
  let exportName = "Export"
  let clipboard = ""
  let pointer = { x: 10, y: 20, held: false }
  let lastAction: ComputerAction | undefined
  const observe = async (): Promise<Observation> => {
    observations += 1
    return {
      id: `obs-${observations}`,
      backend: "test",
      elements: [
        { id: "x11:0x1", role: "window", name: "Editor Window", states: focusedWindow === "x11:0x1" ? ["focused"] : [], actions: [] },
        { id: "x11:0x2", role: "window", name: "Other Window", states: focusedWindow === "x11:0x2" ? ["focused"] : [], actions: [] },
        {
          id: "el-1",
          role: "button",
          name: exportName,
          states: [],
          actions: ["click"],
          bounds: { x: 100, y: 100, width: 40, height: 20 },
        },
        ...(dialogOpen
          ? [{ id: "el-2", role: "dialog", name: "Export options", states: [], actions: [] }]
          : []),
      ],
    }
  }
  return {
    id: "local",
    backend: "test",
    getInfo: async () => ({
      id: "local",
      name: "Test Computer",
      platform: "linux",
      backend: "test",
      connected: true,
    }),
    capabilities: () => [{ capability: "accessibility", status: "available", score: 1 }],
    observe,
    find: async (request) => ({
      query: request.query,
      matches: [{ element: { id: "el-1", role: "button", name: "Export" }, score: 0.9 }],
    }),
    execute: async (action: ComputerAction): Promise<ActionResult> => {
      lastAction = action
      if (action.type === "click") dialogOpen = true
      if (action.type === "type" && typeof action.text === "string") typed = action.text
      if (action.type === "focus" && action.target !== undefined && typeof action.target === "object" && action.target.kind === "element") {
        focusedWindow = action.target.elementId
      }
      return { success: true, status: "success", message: `Executed ${action.type}.`, observation: await observe() }
    },
    readText: async (input) => {
      if (input.elementId !== "el-1") return { success: false, status: "failed", message: "No text on this element." }
      return { success: true, status: "success", message: `Read ${typed.length} characters.`, text: typed, length: typed.length, hash: "abc123" }
    },
    readClipboard: async () => ({
      success: true,
      status: "success",
      message: `Read ${clipboard.length} clipboard characters.`,
      text: clipboard,
      length: clipboard.length,
      hash: "clip123",
    }),
    writeClipboard: async (text) => {
      clipboard = text
      return { success: true, status: "success", message: `Wrote ${text.length} characters to the clipboard.` }
    },
    pointerPosition: async () => ({
      success: true,
      status: "success",
      message: `The pointer is at ${pointer.x},${pointer.y}.`,
      x: pointer.x,
      y: pointer.y,
      held: pointer.held,
    }),
    hoverPointer: async (x, y) => {
      pointer = { ...pointer, x, y }
      return { success: true, status: "success", message: `Hovered at ${x},${y}.` }
    },
    mouseDown: async () => {
      pointer = { ...pointer, held: true }
      return { success: true, status: "success", message: "Held mouse button 1." }
    },
    mouseUp: async () => {
      pointer = { ...pointer, held: false }
      return { success: true, status: "success", message: "Released mouse button 1." }
    },
    revalidateTarget: async (reference) => ({
      valid: reference.elementId === "el-1" || reference.elementId === "x11:0x1" || reference.elementId === "x11:0x2",
      ...(reference.elementId === "el-1" || reference.elementId === "x11:0x1" || reference.elementId === "x11:0x2"
        ? {}
        : { reason: "missing" }),
    }),
    rename: (name: string) => {
      exportName = name
    },
    lastAction: () => lastAction,
  }
}

function createFakeBrowser(): BrowserController {
  let page = { url: "https://example.com", title: "Example", text: "hello page", length: 10, hash: "hash-1" }
  const tabs = [{ id: "tab-1", url: "https://example.com" }]
  return {
    status: async () => ({ running: true, browser: "test 1.0", tabs: tabs.length }),
    open: async (url) => ({ id: "tab-2", url: url ?? "about:blank" }),
    tabs: async () => tabs,
    activate: async () => undefined,
    closeTab: async () => undefined,
    navigate: async (url) => {
      page = { ...page, url, hash: `hash-${url}` }
      return { id: "tab-1", url }
    },
    read: async () => page,
    find: async (query) => [{ id: "omnia-1", role: "button", name: query, visible: true, disabled: false, score: 1 }],
    click: async () => {
      page = { ...page, hash: "hash-after-click" }
      return { clicked: true, name: "Export", role: "button" }
    },
    type: async (target) => ({ typed: true, value: target.text }),
    key: async () => undefined,
    back: async () => undefined,
    forward: async () => undefined,
    reload: async () => undefined,
  }
}

async function withServer<T>(fn: (server: Awaited<ReturnType<typeof startOmniaServer>>) => Promise<T>): Promise<T> {
  const server = await startOmniaServer({ drivers: [createFakeDriver()], browser: createFakeBrowser() })
  try {
    return await fn(server)
  } finally {
    await server.stop()
  }
}

const headers = (server: { token: string }, sessionId?: string) => ({
  authorization: `Bearer ${server.token}`,
  "content-type": "application/json",
  ...(sessionId === undefined ? {} : { "x-omnia-session-proof": sessionProof(server.token, sessionId) }),
})

describe("omnia server", () => {
  test("starts on loopback with health and capability reporting", async () => {
    await withServer(async (server) => {
      expect(server.url.startsWith("http://127.0.0.1:")).toBe(true)
      const response = await fetch(`${server.url}/v1/health`, { headers: headers(server) })
      const body = (await response.json()) as { ok: boolean; health: { status: string; protocol: number } }
      expect(body.ok).toBe(true)
      expect(body.health.protocol).toBe(1)
      expect(body.health.status).toBe("ready")

      const capabilities = (await (await fetch(`${server.url}/v1/capabilities`, { headers: headers(server) })).json()) as {
        computers: Array<{ id: string; capabilities: Array<{ capability: string }> }>
      }
      expect(capabilities.computers).toHaveLength(1)
      expect(capabilities.computers[0]!.id).toBe("local")
    })
  })

  test("rejects unauthenticated requests", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/health`)
      expect(response.status).toBe(401)
    })
  })

  test("answers CORS preflight before the bearer check", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, { method: "OPTIONS" })
      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-origin")).toBe("*")
      expect(response.headers.get("access-control-allow-methods")).toContain("POST")
    })
  })

  test("maps invalid JSON and oversized bodies to typed errors", async () => {
    await withServer(async (server) => {
      const invalid = await fetch(`${server.url}/v1/computers/pair`, {
        method: "POST",
        headers: headers(server),
        body: "{ not json",
      })
      expect(invalid.status).toBe(400)
      const invalidBody = (await invalid.json()) as { error: string }
      expect(invalidBody.error).toBe("Request body is not valid JSON.")

      const oversized = await fetch(`${server.url}/v1/computers/pair`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ name: "x".repeat(16 * 1024 * 1024 + 1) }),
      })
      expect(oversized.status).toBe(413)
      const oversizedBody = (await oversized.json()) as { error: string }
      expect(oversizedBody.error).toBe("Request body too large.")
    })
  })

  test("maps browser failures to per-code HTTP statuses", async () => {
    const browser: BrowserController = {
      ...createFakeBrowser(),
      read: async () => {
        throw new Error("browser read exploded")
      },
    }
    const server = await startOmniaServer({ drivers: [createFakeDriver()], browser })
    try {
      const invalid = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ action: "browser_navigate", approve: true, approvedScopes: ["BROWSER"] }),
      })
      expect(invalid.status).toBe(400)
      expect(((await invalid.json()) as { result: { error: { code: string } } }).result.error.code).toBe("invalid_action")

      const unavailable = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ action: "browser_bogus", approve: true, approvedScopes: ["BROWSER"] }),
      })
      expect(unavailable.status).toBe(501)
      expect(((await unavailable.json()) as { result: { error: { code: string } } }).result.error.code).toBe("operation_unavailable")

      const failed = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ action: "browser_read", approve: true, approvedScopes: ["BROWSER"] }),
      })
      expect(failed.status).toBe(500)
      expect(((await failed.json()) as { result: { error: { code: string } } }).result.error.code).toBe("browser_error")
    } finally {
      await server.stop()
    }
  })

  test("reports image saves outside the sandbox as files_write_required", async () => {
    const browser: BrowserController = {
      ...createFakeBrowser(),
      saveImage: async (target) => ({
        path: target.path ?? "/tmp/image.png",
        bytes: 3,
        src: "https://example.com/image.png",
        alt: "",
        method: "fetch",
      }),
    }
    const server = await startOmniaServer({ drivers: [createFakeDriver()], browser })
    try {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({
          action: "browser_save_image",
          path: "/etc/omnia-image.png",
          approve: true,
          approvedScopes: ["BROWSER"],
        }),
      })
      expect(response.status).toBe(428)
      const body = (await response.json()) as { result: { error: { code: string } } }
      expect(body.result.error.code).toBe("files_write_required")
    } finally {
      await server.stop()
    }
  })

  test("observes, finds, and lists computers", async () => {
    await withServer(async (server) => {
      const observe = (await (
        await fetch(`${server.url}/v1/computers/local/observe`, { method: "POST", headers: headers(server), body: "{}" })
      ).json()) as { ok: boolean; observation: Observation }
      expect(observe.ok).toBe(true)
      expect(observe.observation.elements?.map((element) => element.id)).toEqual(["x11:0x1", "x11:0x2", "el-1"])

      const find = (await (
        await fetch(`${server.url}/v1/computers/local/find`, {
          method: "POST",
          headers: headers(server),
          body: JSON.stringify({ query: "Export" }),
        })
      ).json()) as { result: { matches: Array<{ element: { id: string } }> } }
      expect(find.result.matches[0]!.element.id).toBe("el-1")

      const list = (await (await fetch(`${server.url}/v1/computers`, { headers: headers(server) })).json()) as {
        computers: Array<{ id: string; backend: string }>
      }
      expect(list.computers[0]).toMatchObject({ id: "local", backend: "test" })
    })
  })

  test("enforces permissions at the server boundary", async () => {
    await withServer(async (server) => {
      const denied = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ action: "click", target: { elementId: "el-1" } }),
      })
      expect(denied.status).toBe(428)
      const deniedBody = (await denied.json()) as { result: { error: { code: string; details?: { missing: string[] } } } }
      expect(deniedBody.result.error.code).toBe("permission_required")
      expect(deniedBody.result.error.details?.missing).toContain("UI_CONTROL")

      const approved = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-1"),
        body: JSON.stringify({
          action: "click",
          target: { elementId: "el-1" },
          approve: true,
          approvedScopes: ["UI_CONTROL"],
          sessionId: "session-1",
        }),
      })
      expect(approved.status).toBe(200)
      const approvedBody = (await approved.json()) as {
        ok: boolean
        result: { success: boolean; verification: { status: string }; metadata: { stateDelta: { hasChanges: boolean } } }
      }
      expect(approvedBody.ok).toBe(true)
      expect(approvedBody.result.verification.status).toBe("verified")
      expect(approvedBody.result.metadata.stateDelta.hasChanges).toBe(true)

      const sessions = (await (await fetch(`${server.url}/v1/sessions`, { headers: headers(server) })).json()) as {
        sessions: Array<{ id: string; actions: number }>
      }
      expect(sessions.sessions[0]).toMatchObject({ id: "session-1", actions: 1 })
    })
  })

  test("gates connect and disconnect for agent sessions, desktop stays allowed", async () => {
    await withServer(async (server) => {
      const denied = await fetch(`${server.url}/v1/computers/local/disconnect`, {
        method: "POST",
        headers: headers(server, "session-connect"),
        body: JSON.stringify({ approve: true, approvedScopes: ["UI_CONTROL"], sessionId: "session-connect" }),
      })
      expect(denied.status).toBe(428)

      const allowed = await fetch(`${server.url}/v1/computers/local/disconnect`, {
        method: "POST",
        headers: headers(server, "session-connect"),
        body: JSON.stringify({ approve: true, approvedScopes: ["PROCESS_EXECUTE"], sessionId: "session-connect" }),
      })
      expect(allowed.status).toBe(200)

      const desktop = await fetch(`${server.url}/v1/computers/local/connect`, {
        method: "POST",
        headers: headers(server),
      })
      expect(desktop.status).toBe(200)
    })
  })

  test("answers an unsupported freeze with 501 instead of 200", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/input/freeze`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ computerId: "local" }),
      })
      expect(response.status).toBe(501)
      const body = (await response.json()) as { ok: boolean }
      expect(body.ok).toBe(false)
    })
  })

  test("get_context requires pointer and browser scopes", async () => {
    await withServer(async (server) => {
      const denied = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-context"),
        body: JSON.stringify({
          action: "get_context",
          approve: true,
          approvedScopes: ["UI_READ"],
          sessionId: "session-context",
        }),
      })
      expect(denied.status).toBe(428)

      const allowed = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-context"),
        body: JSON.stringify({
          action: "get_context",
          approve: true,
          approvedScopes: ["UI_READ", "POINTER", "BROWSER"],
          sessionId: "session-context",
        }),
      })
      expect(allowed.status).toBe(200)
    })
  })

  test("honors granted permission scopes without per-request approval", async () => {
    const server = await startOmniaServer({ drivers: [createFakeDriver()] })
    try {
      await fetch(`${server.url}/v1/permissions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ scope: "UI_CONTROL", state: "granted" }),
      })
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ action: "click", target: { elementId: "el-1" } }),
      })
      expect(response.status).toBe(200)
    } finally {
      await server.stop()
    }
  })

  test("reports stale targets before executing", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({
          action: "click",
          target: { elementId: "gone" },
          approve: true,
          approvedScopes: ["UI_CONTROL"],
        }),
      })
      expect(response.status).toBe(409)
      const body = (await response.json()) as { result: { error: { code: string } } }
      expect(body.result.error.code).toBe("target_stale")
    })
  })

  test("refuses to act when a cached element identity changed", async () => {
    const driver = createFakeDriver()
    const server = await startOmniaServer({ drivers: [driver] })
    try {
      await fetch(`${server.url}/v1/computers/local/observe`, {
        method: "POST",
        headers: headers(server),
        body: "{}",
      })
      driver.rename("Delete Everything")
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-id"),
        body: JSON.stringify({
          action: "click",
          target: { elementId: "el-1" },
          approve: true,
          approvedScopes: ["UI_CONTROL"],
          sessionId: "session-id",
        }),
      })
      expect(response.status).toBe(409)
      const body = (await response.json()) as {
        result: { error: { code: string; details?: { actual?: { name?: string } } }; metadata?: { context?: string[] } }
      }
      expect(body.result.error.code).toBe("target_mismatch")
      expect(body.result.error.details?.actual?.name).toBe("Delete Everything")
      expect(body.result.metadata?.context?.length).toBeGreaterThan(0)
    } finally {
      await server.stop()
    }
  })

  test("verifies typing by reading the text back", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-type"),
        body: JSON.stringify({
          action: "type",
          target: { elementId: "el-1" },
          text: "hello document",
          approve: true,
          approvedScopes: ["UI_CONTROL", "KEYBOARD"],
          sessionId: "session-type",
        }),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { result: { verification: { status: string; method?: string } } }
      expect(body.result.verification.status).toBe("verified")
      expect(body.result.verification.method).toBe("text-readback")
    })
  })

  test("reads and writes the clipboard through server actions", async () => {
    await withServer(async (server) => {
      const write = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-clip"),
        body: JSON.stringify({
          action: "write_clipboard",
          text: "shared text",
          approve: true,
          approvedScopes: ["CLIPBOARD_WRITE", "KEYBOARD"],
          sessionId: "session-clip",
        }),
      })
      expect(write.status).toBe(200)
      const read = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-clip"),
        body: JSON.stringify({
          action: "read_clipboard",
          approve: true,
          approvedScopes: ["CLIPBOARD_READ"],
          sessionId: "session-clip",
        }),
      })
      const body = (await read.json()) as { result: { text?: string; metadata?: { length?: number } } }
      expect(body.result.text).toBe("shared text")
      expect(body.result.metadata?.length).toBe(11)
    })
  })

  test("reports and moves the real pointer", async () => {
    await withServer(async (server) => {
      const cursor = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-pointer"),
        body: JSON.stringify({ action: "get_cursor", approve: true, sessionId: "session-pointer" }),
      })
      const cursorBody = (await cursor.json()) as { result: { metadata: { x?: number; y?: number } } }
      expect(cursorBody.result.metadata.x).toBe(10)
      expect(cursorBody.result.metadata.y).toBe(20)

      const hover = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-pointer"),
        body: JSON.stringify({
          action: "hover",
          target: { elementId: "el-1" },
          approve: true,
          approvedScopes: ["POINTER"],
          sessionId: "session-pointer",
        }),
      })
      expect(hover.status).toBe(200)
      const after = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-pointer"),
        body: JSON.stringify({ action: "get_cursor", approve: true, sessionId: "session-pointer" }),
      })
      const afterBody = (await after.json()) as { result: { metadata: { x?: number } } }
      expect(afterBody.result.metadata.x).not.toBe(10)
    })
  })

  test("maps middle_click to a middle-button click", async () => {
    const driver = createFakeDriver()
    const server = await startOmniaServer({ drivers: [driver] })
    try {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-mid"),
        body: JSON.stringify({
          action: "middle_click",
          target: { elementId: "el-1" },
          approve: true,
          approvedScopes: ["POINTER"],
          sessionId: "session-mid",
        }),
      })
      expect(response.status).toBe(200)
      expect(driver.lastAction()).toMatchObject({ type: "click", button: "middle" })
    } finally {
      await server.stop()
    }
  })

  test("presses and releases mouse buttons", async () => {
    await withServer(async (server) => {
      const down = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-mouse"),
        body: JSON.stringify({
          action: "mouse_down",
          approve: true,
          approvedScopes: ["POINTER"],
          sessionId: "session-mouse",
        }),
      })
      expect(down.status).toBe(200)
      const cursor = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-mouse"),
        body: JSON.stringify({ action: "get_cursor", approve: true, sessionId: "session-mouse" }),
      })
      const cursorBody = (await cursor.json()) as { result: { metadata: { held?: boolean } } }
      expect(cursorBody.result.metadata.held).toBe(true)
      const up = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-mouse"),
        body: JSON.stringify({
          action: "mouse_up",
          approve: true,
          approvedScopes: ["POINTER"],
          sessionId: "session-mouse",
        }),
      })
      expect(up.status).toBe(200)
    })
  })

  test("reports the focused element", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-focus"),
        body: JSON.stringify({ action: "get_focus", approve: true, sessionId: "session-focus" }),
      })
      const body = (await response.json()) as { result: { metadata: { focused: { id?: string } } } }
      expect(response.status).toBe(200)
      expect(body.result.metadata.focused?.id).toBe("x11:0x1")
    })
  })

  test("resolves semantic queries server-side", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-q"),
        body: JSON.stringify({
          action: "click",
          query: "Export",
          approve: true,
          approvedScopes: ["UI_CONTROL"],
          sessionId: "session-q",
        }),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        result: { success: boolean; metadata: { resolvedBy?: string; confidence?: number } }
      }
      expect(body.result.success).toBe(true)
      expect(body.result.metadata.resolvedBy).toBe("semantic-query")
      expect(body.result.metadata.confidence).toBeCloseTo(0.9)
    })
  })

  test("runs batch steps with per-step verification", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/do`, {
        method: "POST",
        headers: headers(server, "session-batch"),
        body: JSON.stringify({
          approve: true,
          sessionId: "session-batch",
          approvedScopes: ["UI_CONTROL"],
          steps: [
            { action: "click", query: "Export" },
            { action: "observe", expect: { text: "Export options" } },
          ],
        }),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        ok: boolean
        result: { success: boolean; completed: number; total: number; steps: Array<{ success: boolean; verification?: { status: string } }> }
      }
      expect(body.ok).toBe(true)
      expect(body.result.completed).toBe(2)
      expect(body.result.steps[0]!.verification?.status).toBe("verified")
      expect(body.result.steps[1]!.success).toBe(true)
    })
  })

  test("stops a batch when an expectation is unmet", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/do`, {
        method: "POST",
        headers: headers(server, "session-expect"),
        body: JSON.stringify({
          approve: true,
          sessionId: "session-expect",
          approvedScopes: ["UI_CONTROL"],
          steps: [
            { action: "observe", expect: { text: "text that never appears" } },
            { action: "observe" },
          ],
        }),
      })
      const body = (await response.json()) as {
        ok: boolean
        result: {
          success: boolean
          failedAt?: number
          steps: Array<{ success: boolean; error?: { code?: string } }>
        }
      }
      expect(body.ok).toBe(false)
      expect(body.result.failedAt).toBe(0)
      expect(body.result.steps[0]!.error?.code).toBe("expectation_unmet")
      expect(body.result.steps).toHaveLength(1)
    })
  })

  test("focuses an unfocused window by title fragment", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-focus"),
        body: JSON.stringify({
          action: "focus_window",
          window: "Other",
          approve: true,
          approvedScopes: ["UI_CONTROL"],
          sessionId: "session-focus",
        }),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { result: { success: boolean; message?: string } }
      expect(body.result.success).toBe(true)
      const observation = (await (
        await fetch(`${server.url}/v1/computers/local/observe`, { method: "POST", headers: headers(server), body: "{}" })
      ).json()) as { observation: Observation }
      const other = observation.observation.elements?.find((element) => element.id === "x11:0x2")
      expect(other?.states).toContain("focused")
    })
  })

  test("reports a missing window instead of guessing", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({
          action: "focus_window",
          window: "Nonexistent",
          approve: true,
          approvedScopes: ["UI_CONTROL"],
        }),
      })
      expect(response.status).toBe(404)
      const body = (await response.json()) as { result: { error: { code: string; details?: { windows: string[] } } } }
      expect(body.result.error.code).toBe("window_not_found")
      expect(body.result.error.details?.windows).toContain("Other Window")
    })
  })

  test("bounds typed text between start and stop markers", () => {
    expect(sliceTypeText("prefix SOURCE body STOP suffix", "SOURCE", "STOP").text).toBe("SOURCE body STOP")
    expect(sliceTypeText("body only", undefined, "only").text).toBe("body only")
    expect(sliceTypeText("body", "missing").error).toContain("start marker")
    expect(sliceTypeText("body", undefined, "missing").error).toContain("stop marker")
    expect(sliceTypeText("plain text").text).toBe("plain text")
  })

  test("refuses to type when a marker is absent", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-marker"),
        body: JSON.stringify({
          action: "type",
          text: "hello world",
          stop: "absent-marker",
          approve: true,
          approvedScopes: ["UI_CONTROL", "KEYBOARD"],
          sessionId: "session-marker",
        }),
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { result: { error: { code: string } } }
      expect(body.result.error.code).toBe("marker_not_found")
    })
  })

  test("drives the browser as a structured surface", async () => {
    await withServer(async (server) => {
      const status = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-browser"),
        body: JSON.stringify({
          action: "browser_status",
          approve: true,
          approvedScopes: ["BROWSER"],
          sessionId: "session-browser",
        }),
      })
      const statusBody = (await status.json()) as { result: { metadata: { status?: { running: boolean } } } }
      expect(statusBody.result.metadata.status?.running).toBe(true)

      const read = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-browser"),
        body: JSON.stringify({
          action: "browser_read",
          approve: true,
          approvedScopes: ["BROWSER"],
          sessionId: "session-browser",
        }),
      })
      const readBody = (await read.json()) as { result: { metadata: { text?: string; length?: number } } }
      expect(readBody.result.metadata.text).toBe("hello page")

      const find = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-browser"),
        body: JSON.stringify({
          action: "browser_find",
          query: "Export",
          approve: true,
          approvedScopes: ["BROWSER"],
          sessionId: "session-browser",
        }),
      })
      const findBody = (await find.json()) as { result: { metadata: { candidates?: Array<{ id: string }> } } }
      expect(findBody.result.metadata.candidates?.[0]?.id).toBe("omnia-1")

      const click = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-browser"),
        body: JSON.stringify({
          action: "browser_click",
          target: { elementId: "omnia-1" },
          approve: true,
          approvedScopes: ["BROWSER"],
          sessionId: "session-browser",
        }),
      })
      const clickBody = (await click.json()) as { result: { success: boolean; verification?: { status: string } } }
      expect(clickBody.result.success).toBe(true)
      expect(clickBody.result.verification?.status).toBe("verified")
    })
  })

  test("verifies browser typing by value readback", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-browser-type"),
        body: JSON.stringify({
          action: "browser_type",
          target: { elementId: "omnia-1" },
          text: "acme industrial",
          approve: true,
          approvedScopes: ["BROWSER"],
          sessionId: "session-browser-type",
        }),
      })
      const body = (await response.json()) as { result: { verification?: { status: string; method?: string } } }
      expect(body.result.verification?.status).toBe("verified")
      expect(body.result.verification?.method).toBe("browser-value-readback")
    })
  })

  test("forwards browser read paging and reports real paging metadata", async () => {
    const reads: Array<{ sessionId?: string; offset?: number; limit?: number; maxChars?: number }> = []
    const browser = createFakeBrowser()
    browser.read = async (_tabId, options) => {
      reads.push(options ?? {})
      return {
        url: "https://example.com",
        title: "Example",
        text: "efgh",
        length: 4,
        hash: "hash-page",
        offset: 4,
        totalLength: 10,
        truncated: true,
        sourceTruncated: false,
      }
    }
    const server = await startOmniaServer({ drivers: [createFakeDriver()], browser })
    try {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-page"),
        body: JSON.stringify({
          action: "browser_read",
          offset: 4,
          maxChars: 4,
          approve: true,
          approvedScopes: ["BROWSER"],
          sessionId: "session-page",
        }),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        result: { metadata: { text?: string; offset?: number; totalLength?: number; truncated?: boolean } }
      }
      expect(body.result.metadata.text).toBe("efgh")
      expect(body.result.metadata.offset).toBe(4)
      expect(body.result.metadata.totalLength).toBe(10)
      expect(body.result.metadata.truncated).toBe(true)
      expect(reads[0]).toEqual({ sessionId: "session-page", offset: 4, limit: 4, maxChars: 4 })
    } finally {
      await server.stop()
    }
  })

  test("enforces the browser target observation binding over HTTP", async () => {
    await withServer(async (server) => {
      const stale = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-bind"),
        body: JSON.stringify({
          action: "browser_click",
          target: { elementId: "omnia-1@doc-42", observationId: "doc-7" },
          approve: true,
          approvedScopes: ["BROWSER"],
          sessionId: "session-bind",
        }),
      })
      expect(stale.status).toBe(409)
      const staleBody = (await stale.json()) as { result: { error?: { code?: string } } }
      expect(staleBody.result.error?.code).toBe("target_stale")

      const matched = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-bind"),
        body: JSON.stringify({
          action: "browser_click",
          target: { elementId: "omnia-1@doc-42", observationId: "doc-42" },
          approve: true,
          approvedScopes: ["BROWSER"],
          sessionId: "session-bind",
        }),
      })
      expect(matched.status).toBe(200)
      const matchedBody = (await matched.json()) as { result: { success: boolean; verification?: { status: string } } }
      expect(matchedBody.result.success).toBe(true)
      expect(matchedBody.result.verification?.status).toBe("verified")
    })
  })

  test("do fails an unverified step unless the step allows it", async () => {
    await withServer(async (server) => {
      await fetch(`${server.url}/v1/computers/local/observe`, { method: "POST", headers: headers(server), body: "{}" })
      const run = async (step: Record<string, unknown>) => {
        const response = await fetch(`${server.url}/v1/computers/local/do`, {
          method: "POST",
          headers: headers(server, "session-plan"),
          body: JSON.stringify({
            approve: true,
            approvedScopes: ["UI_CONTROL"],
            sessionId: "session-plan",
            steps: [step],
          }),
        })
        return (await response.json()) as {
          ok: boolean
          result: {
            success: boolean
            verified: boolean
            steps: Array<{ success: boolean; verified: boolean; allowUnverified?: boolean; error?: { code?: string } }>
          }
        }
      }

      const failed = await run({ action: "click", target: { elementId: "x11:0x1" } })
      expect(failed.ok).toBe(false)
      expect(failed.result.success).toBe(false)
      expect(failed.result.verified).toBe(false)
      expect(failed.result.steps[0]?.verified).toBe(false)
      expect(failed.result.steps[0]?.error?.code).toBe("unverified")

      const allowed = await run({ action: "click", target: { elementId: "x11:0x1" }, allowUnverified: true })
      expect(allowed.ok).toBe(true)
      expect(allowed.result.success).toBe(true)
      expect(allowed.result.steps[0]?.success).toBe(true)
      expect(allowed.result.steps[0]?.verified).toBe(false)
      expect(allowed.result.steps[0]?.allowUnverified).toBe(true)
      // An opted-out step passes its step, but the plan is never marked verified.
      expect(allowed.result.verified).toBe(false)
    })
  })

  test("parses the text action protocol", () => {
    const parsed = parseActionScript(
      [
        "# a plan",
        'click query="Export button"',
        'type query="Find" text="invoice \\"42\\"" endKey=Return',
        "hotkey keys=ctrl+shift+s",
        'launch_app app="soffice --writer" expect_window="LibreOffice Writer"',
        "wait amount=800",
      ].join("\n"),
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.steps).toHaveLength(5)
    expect(parsed.steps[0]).toMatchObject({ action: "click", query: "Export button" })
    expect(parsed.steps[1]).toMatchObject({ action: "type", text: 'invoice "42"', endKey: "Return" })
    expect(parsed.steps[2]).toMatchObject({ action: "hotkey", keys: ["ctrl", "shift", "s"] })
    expect(parsed.steps[3]).toMatchObject({ action: "launch_app", app: "soffice --writer", expect: { window: "LibreOffice Writer" } })
    expect(parsed.steps[4]).toMatchObject({ action: "wait", amount: 800 })

    const broken = parseActionScript("click query=Export\nnot-a-pair")
    expect(broken.errors[0]?.line).toBe(2)
  })

  test("rejects non-finite and out-of-range numeric arguments", () => {
    const parsed = parseActionScript(
      ["wait amount=Infinity", "wait amount=-5", "read_text limit=NaN", "move x=Infinity y=10"].join("\n"),
    )
    expect(parsed.steps).toHaveLength(0)
    expect(parsed.errors).toHaveLength(4)
    expect(parsed.errors[0]?.message).toContain('"amount"')

    const negative = parseActionScript("move x=-10 y=-20")
    expect(negative.errors).toEqual([])
    expect(negative.steps[0]).toMatchObject({ action: "move", x: -10, y: -20 })
  })

  test("parses observation, paging, and allow_unverified script arguments", () => {
    const parsed = parseActionScript(
      ["browser_read offset=5 maxChars=100 observation_id=obs-2", "click target=el-1 allow_unverified=true"].join("\n"),
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.steps[0]).toMatchObject({ action: "browser_read", offset: 5, maxChars: 100, observationId: "obs-2" })
    expect(parsed.steps[1]).toMatchObject({ action: "click", target: { kind: "element", elementId: "el-1" }, allowUnverified: true })
  })

  test("advertises real parameter types and the window/calibration/cua surfaces", () => {
    const schemas = renderToolSchemas()
    const names = schemas.map((schema) => schema.name)
    expect(names).toContain("omnia_window_tile")
    expect(names).toContain("omnia_window_close")
    expect(names).toContain("omnia_calibration_measure")
    expect(names).toContain("omnia_cua_snapshot")
    expect(names).toContain("omnia_cua_act")

    const properties = (name: string) => {
      const schema = schemas.find((entry) => entry.name === name)
      return (schema?.parameters as { properties: Record<string, { type: string }> }).properties
    }
    expect(properties("omnia_wait").amount?.type).toBe("number")
    expect(properties("omnia_click").action?.type).toBe("string")
    expect(properties("omnia_cua_snapshot").includeScreenshot?.type).toBe("boolean")
    expect(properties("omnia_cua_snapshot").maxElements?.type).toBe("number")
    expect(properties("omnia_cua_wait").timeoutMs?.type).toBe("number")

    expect(OMNIA_ACTION_CATALOG.find((entry) => entry.action === "window_close")?.requires).toEqual(["PROCESS_EXECUTE"])
    expect(OMNIA_ACTION_CATALOG.find((entry) => entry.action === "get_context")?.requires).toEqual(["UI_READ", "POINTER", "BROWSER"])
    expect(OMNIA_ACTION_CATALOG.find((entry) => entry.action === "paste_table")?.requires).toContain("POINTER")
    expect(OMNIA_ACTION_CATALOG.find((entry) => entry.action === "scroll_into_view")?.requires).toEqual(["POINTER"])
  })

  test("executes a text action script and refuses malformed ones", async () => {
    const driver = createFakeDriver()
    const server = await startOmniaServer({ drivers: [driver], browser: createFakeBrowser() })
    try {
      const response = await fetch(`${server.url}/v1/computers/local/text`, {
        method: "POST",
        headers: headers(server, "session-text"),
        body: JSON.stringify({
          approve: true,
          sessionId: "session-text",
          approvedScopes: ["UI_READ", "UI_CONTROL"],
          script: 'click query="Export"\nread_text target="el-1"',
        }),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { ok: boolean; result: { completed: number; steps: Array<{ success: boolean }> } }
      expect(body.ok).toBe(true)
      expect(body.result.completed).toBe(2)
      const afterScript = driver.lastAction()

      const malformed = await fetch(`${server.url}/v1/computers/local/text`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ approve: true, script: "click query=Export\nthis line is broken" }),
      })
      expect(malformed.status).toBe(400)
      const malformedBody = (await malformed.json()) as { errors?: Array<{ line: number }> }
      expect(malformedBody.errors?.[0]?.line).toBe(2)
      expect(driver.lastAction()).toBe(afterScript)
    } finally {
      await server.stop()
    }
  })

  test("renders the catalog for tool-less and tool-calling models", async () => {
    await withServer(async (server) => {
      const text = await (await fetch(`${server.url}/v1/actions?format=text`, { headers: headers(server) })).text()
      expect(text).toContain("TEXT PROTOCOL")
      expect(text).toContain("browser_open")
      const openai = (await (await fetch(`${server.url}/v1/actions?format=openai`, { headers: headers(server) })).json()) as {
        tools: Array<{ type: string; function: { name: string } }>
      }
      expect(openai.tools[0]?.type).toBe("function")
      const anthropic = (await (await fetch(`${server.url}/v1/actions?format=anthropic`, { headers: headers(server) })).json()) as {
        tools: Array<{ name: string; input_schema: unknown }>
      }
      expect(anthropic.tools[0]?.input_schema).toBeDefined()
    })
  })

  test("registers models with capability flags", async () => {
    await withServer(async (server) => {
      const registered = await fetch(`${server.url}/v1/models`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({
          models: [
            { id: "local/llama-3.2-3b", provider: "ollama", capabilities: { tools: false, vision: false, context: 128000 } },
          ],
        }),
      })
      expect(registered.status).toBe(200)
      const models = (await (await fetch(`${server.url}/v1/models`, { headers: headers(server) })).json()) as {
        models: Array<{ id: string; capabilities?: { tools?: boolean; context?: number } }>
      }
      expect(models.models[0]?.id).toBe("local/llama-3.2-3b")
      expect(models.models[0]?.capabilities?.tools).toBe(false)
    })
  })

  test("stops a batch when the client disconnects", async () => {
    await withServer(async (server) => {
      let checks = 0
      const outcome = await server.computers.executeBatch("local", {
        approve: true,
        sessionId: "session-cancel",
        approvedScopes: ["UI_CONTROL"],
        steps: [{ action: "observe" }, { action: "observe" }, { action: "observe" }],
        shouldStop: () => {
          checks += 1
          return checks > 2
        },
      })
      expect(outcome.result.steps.length).toBe(2)
      expect(outcome.result.message).toContain("disconnected")
    })
  })

  test("manages and calls superskills through the API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-superskill-api-"))
    const script = join(dir, "echo.py")
    writeFileSync(
      script,
      `import json\nimport sys\nfor line in sys.stdin:\n    request = json.loads(line)\n    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": request.get("params")}), flush=True)\n`,
    )
    const server = await startOmniaServer({
      drivers: [createFakeDriver()],
      browser: createFakeBrowser(),
      superskillFile: join(dir, "superskills.json"),
    })
    try {
      const saved = await fetch(`${server.url}/v1/superskills`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({
          id: "echo",
          name: "Echo",
          description: "Echoes params.",
          instructions: "Use ping.",
          enabled: true,
          bridge: { type: "stdio", command: `python3 ${script}` },
          methods: [{ name: "ping", description: "Echo." }],
        }),
      })
      expect(saved.status).toBe(200)
      const savedBody = (await saved.json()) as { superskill: { bridge: Record<string, unknown> } }
      expect(savedBody.superskill.bridge.command).toBeUndefined()
      expect(savedBody.superskill.bridge.envKeys).toBeUndefined()
      expect(savedBody.superskill.bridge.type).toBe("stdio")

      const list = (await (await fetch(`${server.url}/v1/superskills`, { headers: headers(server) })).json()) as {
        superskills: Array<{ id: string; methods: string[] }>
      }
      expect(list.superskills[0]?.id).toBe("echo")

      const denied = await fetch(`${server.url}/v1/superskills/echo/call`, {
        method: "POST",
        headers: headers(server, "session-skill"),
        body: JSON.stringify({ method: "ping", params: { value: 1 }, sessionId: "session-skill" }),
      })
      expect(denied.status).toBe(428)

      const called = await fetch(`${server.url}/v1/superskills/echo/call`, {
        method: "POST",
        headers: headers(server, "session-skill"),
        body: JSON.stringify({
          method: "ping",
          params: { value: 7 },
          approve: true,
          approvedScopes: ["PROCESS_EXECUTE"],
          sessionId: "session-skill",
        }),
      })
      expect(called.status).toBe(200)
      const calledBody = (await called.json()) as { result: { value: number } }
      expect(calledBody.result.value).toBe(7)

      const removed = (await (
        await fetch(`${server.url}/v1/superskills/echo`, { method: "DELETE", headers: headers(server) })
      ).json()) as { removed: boolean }
      expect(removed.removed).toBe(true)
    } finally {
      await server.stop()
    }
  })

  test("empty superskill scopes default to the bridge's PROCESS_EXECUTE gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-superskill-scopes-"))
    const script = join(dir, "echo.py")
    writeFileSync(
      script,
      `import json\nimport sys\nfor line in sys.stdin:\n    request = json.loads(line)\n    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": request.get("params")}), flush=True)\n`,
    )
    const server = await startOmniaServer({
      drivers: [createFakeDriver()],
      browser: createFakeBrowser(),
      superskillFile: join(dir, "superskills.json"),
    })
    try {
      const saved = await fetch(`${server.url}/v1/superskills`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({
          id: "empty",
          name: "Empty",
          description: "Declares no scopes.",
          enabled: true,
          scopes: [],
          bridge: { type: "stdio", command: `python3 ${script}` },
          methods: [{ name: "ping", description: "Echo.", scopes: [] }],
        }),
      })
      expect(saved.status).toBe(200)

      const denied = await fetch(`${server.url}/v1/superskills/empty/call`, {
        method: "POST",
        headers: headers(server, "session-skill"),
        body: JSON.stringify({
          method: "ping",
          approve: true,
          approvedScopes: ["UI_READ"],
          sessionId: "session-skill",
        }),
      })
      expect(denied.status).toBe(428)
      const deniedBody = (await denied.json()) as { result?: { error?: { details?: { missing?: string[] } } } }
      expect(deniedBody.result?.error?.details?.missing).toContain("PROCESS_EXECUTE")

      const allowed = await fetch(`${server.url}/v1/superskills/empty/call`, {
        method: "POST",
        headers: headers(server, "session-skill"),
        body: JSON.stringify({
          method: "ping",
          approve: true,
          approvedScopes: ["PROCESS_EXECUTE"],
          sessionId: "session-skill",
        }),
      })
      expect(allowed.status).toBe(200)
    } finally {
      await server.stop()
    }
  })

  test("stores and recalls memories with permission checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-memory-api-"))
    const server = await startOmniaServer({
      drivers: [createFakeDriver()],
      browser: createFakeBrowser(),
      memoryFile: join(dir, "memories.json"),
    })
    try {
      const denied = await fetch(`${server.url}/v1/memories`, {
        method: "POST",
        headers: headers(server, "session-mem"),
        body: JSON.stringify({ scope: "task", text: "supplier comparison notes", sessionId: "session-mem" }),
      })
      expect(denied.status).toBe(428)

      const written = await fetch(`${server.url}/v1/memories`, {
        method: "POST",
        headers: headers(server, "session-mem"),
        body: JSON.stringify({
          scope: "task",
          text: "supplier comparison notes: prefer CSV exports",
          sessionId: "session-mem",
          approve: true,
          approvedScopes: ["FILES_WRITE"],
        }),
      })
      expect(written.status).toBe(200)

      const settingsWrite = await fetch(`${server.url}/v1/memories`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ scope: "user", text: "prefers dark mode" }),
      })
      expect(settingsWrite.status).toBe(200)

      const search = (await (
        await fetch(`${server.url}/v1/memories?query=supplier`, { headers: headers(server) })
      ).json()) as { memories: Array<{ text: string; scope: string }>; total: number }
      expect(search.total).toBe(1)
      expect(search.memories[0]?.scope).toBe("task")

      const stats = (await (await fetch(`${server.url}/v1/memories/stats`, { headers: headers(server) })).json()) as {
        stats: { total: number; byScope: Record<string, number> }
      }
      expect(stats.stats.total).toBe(2)
      expect(stats.stats.byScope.user).toBe(1)

      const forgotten = (await (
        await fetch(`${server.url}/v1/memories/forget`, {
          method: "POST",
          headers: headers(server, "session-mem"),
          body: JSON.stringify({ query: "supplier", sessionId: "session-mem", approve: true, approvedScopes: ["FILES_WRITE"] }),
        })
      ).json()) as { removed: number }
      expect(forgotten.removed).toBe(1)
    } finally {
      await server.stop()
    }
  })

  test("publishes the action catalog for any AI client", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/actions`, { headers: headers(server) })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { actions: Array<{ action: string; requires: string[] }> }
      const names = body.actions.map((entry) => entry.action)
      expect(names).toContain("focus_window")
      expect(names).toContain("drag")
      expect(names).toContain("do")
      expect(body.actions.find((entry) => entry.action === "launch_app")?.requires).toContain("PROCESS_EXECUTE")
    })
  })

  test("streams events over SSE with replay", async () => {
    await withServer(async (server) => {
      const controller = new AbortController()
      const response = await fetch(`${server.url}/v1/events`, { headers: headers(server), signal: controller.signal })
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      const readUntil = async (needle: string) => {
        for (let index = 0; index < 50; index += 1) {
          const result = await Promise.race([
            reader.read(),
            new Promise<{ done: true; value: undefined }>((resolve) =>
              setTimeout(() => resolve({ done: true, value: undefined }), 2000),
            ),
          ])
          if (result.done || result.value === undefined) break
          buffer += decoder.decode(result.value as Uint8Array)
          if (buffer.includes(needle)) return true
        }
        return false
      }
      expect(await readUntil("server.snapshot")).toBe(true)
      await fetch(`${server.url}/v1/computers/local/observe`, { method: "POST", headers: headers(server), body: "{}" })
      expect(await readUntil("observation.created")).toBe(true)
      controller.abort()
    })
  })

  test("stops cleanly and refuses further requests", async () => {
    const server = await startOmniaServer({ drivers: [createFakeDriver()] })
    await server.stop()
    expect(server.health().status).toBe("stopped")
    const failed = await fetch(`${server.url}/v1/health`, { headers: headers(server) }).catch(() => undefined)
    expect(failed).toBeUndefined()
  })

  test("catalog endpoints report registered agents, skills, and models", async () => {
    await withServer(async (server) => {
      server.setCatalog({ skills: [{ id: "research", name: "Research" }] })
      const skills = (await (await fetch(`${server.url}/v1/skills`, { headers: headers(server) })).json()) as {
        skills: Array<{ id: string }>
      }
      expect(skills.skills[0]!.id).toBe("research")
      const agents = (await (await fetch(`${server.url}/v1/agents`, { headers: headers(server) })).json()) as {
        agents: unknown[]
      }
      expect(agents.agents).toEqual([])
    })
  })
})
