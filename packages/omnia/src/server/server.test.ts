import { describe, expect, test } from "bun:test"
import { startOmniaServer } from "./server"
import { sliceTypeText } from "./computers"
import { parseActionScript } from "./text-protocol"
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

const headers = (server: { token: string }) => ({
  authorization: `Bearer ${server.token}`,
  "content-type": "application/json",
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
        headers: headers(server),
        body: JSON.stringify({ action: "click", target: { elementId: "el-1" }, approve: true, sessionId: "session-1" }),
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
        body: JSON.stringify({ action: "click", target: { elementId: "gone" }, approve: true }),
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
        headers: headers(server),
        body: JSON.stringify({ action: "click", target: { elementId: "el-1" }, approve: true, sessionId: "session-id" }),
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
        headers: headers(server),
        body: JSON.stringify({
          action: "type",
          target: { elementId: "el-1" },
          text: "hello document",
          approve: true,
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
        headers: headers(server),
        body: JSON.stringify({ action: "write_clipboard", text: "shared text", approve: true, sessionId: "session-clip" }),
      })
      expect(write.status).toBe(200)
      const read = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ action: "read_clipboard", approve: true, sessionId: "session-clip" }),
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
        headers: headers(server),
        body: JSON.stringify({ action: "get_cursor", approve: true, sessionId: "session-pointer" }),
      })
      const cursorBody = (await cursor.json()) as { result: { metadata: { x?: number; y?: number } } }
      expect(cursorBody.result.metadata.x).toBe(10)
      expect(cursorBody.result.metadata.y).toBe(20)

      const hover = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ action: "hover", target: { elementId: "el-1" }, approve: true, sessionId: "session-pointer" }),
      })
      expect(hover.status).toBe(200)
      const after = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
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
        headers: headers(server),
        body: JSON.stringify({ action: "middle_click", target: { elementId: "el-1" }, approve: true, sessionId: "session-mid" }),
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
        headers: headers(server),
        body: JSON.stringify({ action: "mouse_down", approve: true, sessionId: "session-mouse" }),
      })
      expect(down.status).toBe(200)
      const cursor = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ action: "get_cursor", approve: true, sessionId: "session-mouse" }),
      })
      const cursorBody = (await cursor.json()) as { result: { metadata: { held?: boolean } } }
      expect(cursorBody.result.metadata.held).toBe(true)
      const up = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ action: "mouse_up", approve: true, sessionId: "session-mouse" }),
      })
      expect(up.status).toBe(200)
    })
  })

  test("reports the focused element", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
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
        headers: headers(server),
        body: JSON.stringify({ action: "click", query: "Export", approve: true, sessionId: "session-q" }),
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
        headers: headers(server),
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
        headers: headers(server),
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
        headers: headers(server),
        body: JSON.stringify({ action: "focus_window", window: "Other", approve: true, sessionId: "session-focus" }),
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
        body: JSON.stringify({ action: "focus_window", window: "Nonexistent", approve: true }),
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
        headers: headers(server),
        body: JSON.stringify({
          action: "type",
          text: "hello world",
          stop: "absent-marker",
          approve: true,
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
        headers: headers(server),
        body: JSON.stringify({ action: "browser_status", approve: true, sessionId: "session-browser" }),
      })
      const statusBody = (await status.json()) as { result: { metadata: { status?: { running: boolean } } } }
      expect(statusBody.result.metadata.status?.running).toBe(true)

      const read = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ action: "browser_read", approve: true, sessionId: "session-browser" }),
      })
      const readBody = (await read.json()) as { result: { metadata: { text?: string; length?: number } } }
      expect(readBody.result.metadata.text).toBe("hello page")

      const find = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ action: "browser_find", query: "Export", approve: true, sessionId: "session-browser" }),
      })
      const findBody = (await find.json()) as { result: { metadata: { candidates?: Array<{ id: string }> } } }
      expect(findBody.result.metadata.candidates?.[0]?.id).toBe("omnia-1")

      const click = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({
          action: "browser_click",
          target: { elementId: "omnia-1" },
          approve: true,
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
        headers: headers(server),
        body: JSON.stringify({
          action: "browser_type",
          target: { elementId: "omnia-1" },
          text: "acme industrial",
          approve: true,
          sessionId: "session-browser-type",
        }),
      })
      const body = (await response.json()) as { result: { verification?: { status: string; method?: string } } }
      expect(body.result.verification?.status).toBe("verified")
      expect(body.result.verification?.method).toBe("browser-value-readback")
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

  test("executes a text action script and refuses malformed ones", async () => {
    const driver = createFakeDriver()
    const server = await startOmniaServer({ drivers: [driver], browser: createFakeBrowser() })
    try {
      const response = await fetch(`${server.url}/v1/computers/local/text`, {
        method: "POST",
        headers: headers(server),
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

      const list = (await (await fetch(`${server.url}/v1/superskills`, { headers: headers(server) })).json()) as {
        superskills: Array<{ id: string; methods: string[] }>
      }
      expect(list.superskills[0]?.id).toBe("echo")

      const denied = await fetch(`${server.url}/v1/superskills/echo/call`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ method: "ping", params: { value: 1 }, sessionId: "session-skill" }),
      })
      expect(denied.status).toBe(428)

      const called = await fetch(`${server.url}/v1/superskills/echo/call`, {
        method: "POST",
        headers: headers(server),
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
        headers: headers(server),
        body: JSON.stringify({ scope: "task", text: "supplier comparison notes", sessionId: "session-mem" }),
      })
      expect(denied.status).toBe(428)

      const written = await fetch(`${server.url}/v1/memories`, {
        method: "POST",
        headers: headers(server),
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
          headers: headers(server),
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
