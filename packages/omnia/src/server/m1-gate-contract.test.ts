/**
 * M1 contract tests for the v27 trust spine.
 *
 * These encode the acceptance conditions frozen in
 * docs/rfc/v27-m1-gate-journal.md.
 *
 * M1-CT-01 and M1-CT-02 are EXPECTED TO FAIL until M1 lands, because the
 * browser and computer-use paths currently bypass the server-side permission
 * gate. M1-CT-03 is a regression guard: desktop-originated calls (no
 * sessionId) must stay allowed, because the UI itself is the approver.
 *
 * Run: bun test src/server/m1-gate-contract.test.ts
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sessionProof } from "./api"
import { startOmniaServer } from "./server"
import type { BrowserController, ServerComputerDriver } from "./computers"
import type { ActionResult, ComputerAction, ElementReference, FindRequest, Observation } from "../protocol"

function tempStores() {
  const dir = mkdtempSync(join(tmpdir(), "omnia-m1-"))
  return {
    credentialsFile: join(dir, "credentials.json"),
    authFile: join(dir, "auth.json"),
    superskillFile: join(dir, "superskills.json"),
    memoryFile: join(dir, "memories.json"),
    computerUseFile: join(dir, "computer-use.json"),
  }
}

function fakeDriver(): ServerComputerDriver {
  const observation: Observation = { id: "obs-1", backend: "test", elements: [] }
  return {
    id: "local",
    backend: "test",
    getInfo: async () => ({ id: "local", name: "Test Computer", platform: "linux", backend: "test", connected: true }),
    capabilities: () => [],
    observe: async () => observation,
    find: async (request: FindRequest) => ({ query: request.query, matches: [] }),
    execute: async (_action: ComputerAction): Promise<ActionResult> => ({
      success: true,
      status: "success",
      message: "ok",
      observation,
    }),
    revalidateTarget: async (reference: ElementReference) => ({ valid: reference.elementId === "omnia-1" }),
  } as unknown as ServerComputerDriver
}

function fakeBrowser(): BrowserController {
  const page = { url: "https://example.com", title: "Example", text: "hello", length: 5, hash: "hash-1" }
  const tabs = [{ id: "tab-1", url: "https://example.com" }]
  return {
    status: async () => ({ running: true, browser: "test 1.0", tabs: 1 }),
    open: async (url) => ({ id: "tab-2", url: url ?? "about:blank" }),
    tabs: async () => tabs,
    activate: async () => undefined,
    closeTab: async () => undefined,
    navigate: async (url) => ({ id: "tab-1", url }),
    read: async () => page,
    find: async (query) => [{ id: "omnia-1", role: "button", name: query, visible: true, disabled: false, score: 1 }],
    click: async () => ({ clicked: true, name: "Export", role: "button" }),
    type: async (target) => ({ typed: true, value: target.text }),
    key: async () => undefined,
    back: async () => undefined,
    forward: async () => undefined,
    reload: async () => undefined,
  }
}

async function withServer<T>(
  permissions: Record<string, "granted" | "prompt" | "denied">,
  fn: (server: Awaited<ReturnType<typeof startOmniaServer>>) => Promise<T>,
): Promise<T> {
  const server = await startOmniaServer({
    drivers: [fakeDriver()],
    browser: fakeBrowser(),
    permissions: permissions as never,
    ...tempStores(),
  })
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

describe("M1 gate contract", () => {
  test("M1-CT-01 browser action without approval is denied server-side", async () => {
    await withServer({ BROWSER: "prompt" }, async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, "session-1"),
        body: JSON.stringify({
          action: "browser_click",
          target: { kind: "element", elementId: "omnia-1" },
          sessionId: "session-1",
        }),
      })
      expect(response.status).toBe(428)
      const body = (await response.json()) as { result?: { error?: { code?: string } } }
      expect(body.result?.error?.code).toBe("permission_required")
    })
  })

  test("M1-CT-02 computer-use analyze without SCREEN_READ approval is denied", async () => {
    await withServer({ SCREEN_READ: "prompt" }, async (server) => {
      const response = await fetch(`${server.url}/v1/computer-use/analyze`, {
        method: "POST",
        headers: headers(server, "session-1"),
        body: JSON.stringify({
          computerId: "local",
          requestedOperation: "inspect",
          targetDescription: "the screen",
          sessionId: "session-1",
        }),
      })
      expect(response.status).toBe(428)
    })
  })

  test("M1-CT-03 desktop-originated browser action remains allowed (UI is the approver)", async () => {
    await withServer({ BROWSER: "prompt" }, async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ action: "browser_click", target: { kind: "element", elementId: "omnia-1" } }),
      })
      expect(response.status).toBe(200)
    })
  })

  test("origin identity: an agent header gates browser actions without a sessionId", async () => {
    await withServer({ BROWSER: "prompt" }, async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: { ...headers(server), "x-omnia-origin": "agent" },
        body: JSON.stringify({ action: "browser_click", target: { kind: "element", elementId: "omnia-1" } }),
      })
      expect(response.status).toBe(428)
      const body = (await response.json()) as { result?: { error?: { code?: string } } }
      expect(body.result?.error?.code).toBe("permission_required")
    })
  })

  test("origin identity: an explicit desktop header keeps browser actions allowed", async () => {
    await withServer({ BROWSER: "prompt" }, async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: { ...headers(server), "x-omnia-origin": "desktop" },
        body: JSON.stringify({ action: "browser_click", target: { kind: "element", elementId: "omnia-1" } }),
      })
      expect(response.status).toBe(200)
    })
  })

  test("origin identity: regular actions stay gated for desktop calls", async () => {
    await withServer({ UI_CONTROL: "prompt" }, async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ action: "click", target: { kind: "element", elementId: "omnia-1" } }),
      })
      expect(response.status).toBe(428)
    })
  })

  // Frozen M1 test list — enabled as the corresponding parts land.
  test.todo("M1-CT-04 every production site drains through gate() (6 sites + expect.file)", () => {})
  test.todo("M1-CT-05 journal JSONL persists every decision; redaction fixture clean", () => {})
  test.todo("M1-CT-06 journal rotation at maxBytes keeps N files and prunes the oldest", () => {})
  test.todo("M1-CT-07 lease expires server-side even with the UI killed", () => {})
  test.todo("M1-CT-08 rehearsal simulate mode emits zero driver input (counter)", () => {})
  test.todo("M1-CT-09 expect.window requires UI_READ before driver.observe()", () => {})
  test.todo("M1-CT-10 desktop-origin decisions are journaled with origin=desktop", () => {})
})
