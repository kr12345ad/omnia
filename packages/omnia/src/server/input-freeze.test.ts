import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { startOmniaServer } from "./server"
import { sessionProof } from "./api"
import { createHostDriver } from "../daemon/host-driver"
import { LinuxHostDriver } from "../daemon/linux"
import type { InputGrabEvent, ServerComputerDriver } from "./computers"
import type { ServerEvent } from "./events"
import type { ActionResult, ComputerAction, ComputerInfo, Observation } from "../protocol"

interface GrabDriver extends ServerComputerDriver {
  triggerEscape: () => void
}

function createGrabDriver(): GrabDriver {
  let frozen = false
  let reason: string | undefined
  let releasedBy: "escape" | "request" = "request"
  const listeners = new Set<(event: InputGrabEvent) => void>()
  const notify = (event: InputGrabEvent) => {
    for (const listener of listeners) listener(event)
  }
  return {
    id: "local",
    backend: "test",
    getInfo: async (): Promise<ComputerInfo> => ({
      id: "local",
      name: "Test Computer",
      platform: "linux",
      backend: "test",
      connected: true,
    }),
    capabilities: () => [],
    observe: async (): Promise<Observation> => ({ id: "obs-1", backend: "test", elements: [] }),
    find: async (request) => ({ query: request.query, matches: [] }),
    execute: async (action: ComputerAction): Promise<ActionResult> => ({
      success: true,
      status: "success",
      message: `Executed ${action.type}.`,
    }),
    grabInput: async (value?: string) => {
      frozen = true
      reason = value
      releasedBy = "request"
      notify({ type: "frozen", ...(value === undefined ? {} : { reason: value }) })
      return { success: true, status: "success", message: "Physical input is frozen.", frozen: true, supported: true, mode: "x11" }
    },
    releaseInput: async () => {
      const source = releasedBy
      frozen = false
      return { success: true, status: "success", message: "Released.", frozen: false, supported: true, releasedBy: source }
    },
    inputGrabState: async () => ({
      success: true,
      status: "success",
      message: "State.",
      frozen,
      supported: true,
      ...(reason === undefined ? {} : { reason }),
    }),
    subscribeInputGrab: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    triggerEscape: () => {
      frozen = false
      releasedBy = "escape"
      notify({ type: "released", releasedBy: "escape" })
    },
  }
}

function createPlainDriver(): ServerComputerDriver {
  return {
    id: "local",
    backend: "test",
    getInfo: async (): Promise<ComputerInfo> => ({
      id: "local",
      name: "Test Computer",
      platform: "linux",
      backend: "test",
      connected: true,
    }),
    capabilities: () => [],
    observe: async (): Promise<Observation> => ({ id: "obs-1", backend: "test", elements: [] }),
    find: async (request) => ({ query: request.query, matches: [] }),
    execute: async (action: ComputerAction): Promise<ActionResult> => ({
      success: true,
      status: "success",
      message: `Executed ${action.type}.`,
    }),
  }
}

const headers = (server: { token: string }) => ({
  authorization: `Bearer ${server.token}`,
  "content-type": "application/json",
})

async function postJson(
  server: { url: string; token: string },
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined
  const response = await fetch(`${server.url}${path}`, {
    method: "POST",
    headers: {
      ...headers(server),
      ...(sessionId === undefined ? {} : { "x-omnia-session-proof": sessionProof(server.token, sessionId) }),
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function getJson(
  server: { url: string; token: string },
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${server.url}${path}`, { headers: headers(server) })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function withGrabServer<T>(
  fn: (server: Awaited<ReturnType<typeof startOmniaServer>>, driver: GrabDriver) => Promise<T>,
): Promise<T> {
  const driver = createGrabDriver()
  const server = await startOmniaServer({ drivers: [driver] })
  try {
    return await fn(server, driver)
  } finally {
    await server.stop()
  }
}

describe("input freeze API", () => {
  test("freezes, reports state, and releases through the frozen contract", async () => {
    await withGrabServer(async (server) => {
      const events: ServerEvent[] = []
      server.events.subscribe((event) => events.push(event))
      const frozen = await postJson(server, "/v1/input/freeze", { reason: "agent task", computerId: "local" })
      expect(frozen.status).toBe(200)
      expect(frozen.body).toEqual({ ok: true, frozen: true, mode: "x11" })

      const frozenState = await getJson(server, "/v1/input/state?computerId=local")
      expect(frozenState.body).toMatchObject({ ok: true, frozen: true, supported: true, reason: "agent task" })

      const released = await postJson(server, "/v1/input/release", { computerId: "local" })
      expect(released.status).toBe(200)
      expect(released.body).toEqual({ ok: true, frozen: false, releasedBy: "request" })

      const releasedState = await getJson(server, "/v1/input/state?computerId=local")
      expect(releasedState.body).toMatchObject({ ok: true, frozen: false, supported: true })

      expect(events.filter((event) => event.type === "input.frozen")).toHaveLength(1)
      const releasedEvents = events.filter((event) => event.type === "input.released")
      expect(releasedEvents).toHaveLength(1)
      expect(releasedEvents[0]?.data).toEqual({ releasedBy: "request" })
    })
  })

  test("surfaces the double-Escape release source and event", async () => {
    await withGrabServer(async (server, driver) => {
      const events: ServerEvent[] = []
      server.events.subscribe((event) => events.push(event))
      expect((await postJson(server, "/v1/input/freeze", { computerId: "local" })).status).toBe(200)

      driver.triggerEscape()
      const state = await getJson(server, "/v1/input/state?computerId=local")
      expect(state.body).toMatchObject({ ok: true, frozen: false, supported: true })

      const released = await postJson(server, "/v1/input/release", { computerId: "local" })
      expect(released.body).toEqual({ ok: true, frozen: false, releasedBy: "escape" })
      expect(events.some((event) => event.type === "input.released" && event.data?.releasedBy === "escape")).toBe(true)
    })
  })

  test("reports unsupported computers without crashing", async () => {
    const server = await startOmniaServer({ drivers: [createPlainDriver()] })
    try {
      const frozen = await postJson(server, "/v1/input/freeze", { computerId: "local" })
      expect(frozen.status).toBe(501)
      expect(frozen.body.ok).toBe(false)
      expect(typeof frozen.body.error).toBe("string")

      const state = await getJson(server, "/v1/input/state?computerId=local")
      expect(state.body).toMatchObject({ ok: true, frozen: false, supported: false })

      const released = await postJson(server, "/v1/input/release", { computerId: "local" })
      expect(released.body).toEqual({ ok: true, frozen: false, releasedBy: "request" })
    } finally {
      await server.stop()
    }
  })

  test("gates agent-originated freezes behind UI_CONTROL", async () => {
    await withGrabServer(async (server) => {
      const denied = await postJson(server, "/v1/input/freeze", { sessionId: "freeze-session", computerId: "local" })
      expect(denied.status).toBe(428)
      expect(denied.body.ok).toBe(false)

      const approved = await postJson(server, "/v1/input/freeze", {
        sessionId: "freeze-session",
        computerId: "local",
        approve: true,
        approvedScopes: ["UI_CONTROL"],
      })
      expect(approved.status).toBe(200)
      expect(approved.body).toEqual({ ok: true, frozen: true, mode: "x11" })
      await postJson(server, "/v1/input/release", { computerId: "local" })
    })
  })

  test("releases the grab when a computer is unregistered", async () => {
    const driver = createGrabDriver()
    const server = await startOmniaServer({})
    const unregister = server.register(driver)
    try {
      expect((await postJson(server, "/v1/input/freeze", { computerId: "local" })).body.frozen).toBe(true)
      unregister()
      expect((await getJson(server, "/v1/input/state?computerId=local")).body.supported).toBe(false)
    } finally {
      await server.stop()
    }
  })
})

const x11Available = process.platform === "linux" && typeof process.env.DISPLAY === "string" && process.env.DISPLAY.length > 0
const x11Describe = x11Available ? describe : describe.skip

function toServerDriver(host: LinuxHostDriver): ServerComputerDriver {
  const driver = createHostDriver(host)
  return {
    id: driver.id,
    backend: driver.backend,
    getInfo: () => driver.getInfo(),
    capabilities: () => driver.capabilities ?? [],
    observe: (request) => driver.observe(request),
    find: (request) => driver.find(request),
    execute: (action) => driver.execute(action),
    pointerPosition: () => driver.pointerPosition!(),
    grabInput: (reason) => driver.grabInput!(reason),
    releaseInput: () => driver.releaseInput!(),
    inputGrabState: () => driver.inputGrabState!(),
    subscribeInputGrab: (listener) => driver.subscribeInputGrab!(listener),
    dispose: () => driver.dispose?.(),
  }
}

// Escape presses from a client that does NOT set XTestGrabControl are subject
// to an active grab, exactly like physical input, so this exercises the real
// double-Escape escape hatch without touching the physical keyboard.
const ESCAPE_SENDER_SCRIPT = `import ctypes
import sys

x11 = ctypes.CDLL("libX11.so.6")
xtst = ctypes.CDLL("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

display = x11.XOpenDisplay(None)
if not display:
    sys.exit(1)
code = x11.XKeysymToKeycode(display, x11.XStringToKeysym(b"Escape"))
xtst.XTestFakeKeyEvent(display, code, 1, 0)
xtst.XTestFakeKeyEvent(display, code, 0, 40)
xtst.XTestFakeKeyEvent(display, code, 1, 0)
xtst.XTestFakeKeyEvent(display, code, 0, 0)
x11.XFlush(display)
x11.XSync(display, 0)
`

async function waitForFrozen(
  server: { url: string; token: string },
  frozen: boolean,
  timeoutMs = 5000,
  computerId = "linux-host",
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let last: Record<string, unknown> = {}
  while (Date.now() < deadline) {
    last = (await getJson(server, `/v1/input/state?computerId=${encodeURIComponent(computerId)}`)).body
    if (last.frozen === frozen) return last
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Input did not become ${frozen ? "frozen" : "released"}: ${JSON.stringify(last)}`)
}

// The glide queues several server-paced motion events, so the pointer settles
// on the exact target only after the X server drains the queue.
async function waitForPointer(host: LinuxHostDriver, x: number, y: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: { x?: number; y?: number } = {}
  while (Date.now() < deadline) {
    last = await host.pointerPosition()
    if (last.x === x && last.y === y) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Pointer did not settle at ${x},${y}: ${JSON.stringify(last)}`)
}

x11Describe("input freeze on a real X11 display", () => {
  test(
    "freezes input, keeps synthetic input working, and releases",
    async () => {
      const host = new LinuxHostDriver()
      const server = await startOmniaServer({ drivers: [toServerDriver(host)] })
      try {
        const events: ServerEvent[] = []
        server.events.subscribe((event) => events.push(event))

        const frozen = await postJson(server, "/v1/input/freeze", { reason: "integration test", computerId: "linux-host" })
        expect(frozen.status).toBe(200)
        expect(frozen.body).toEqual({ ok: true, frozen: true, mode: "x11" })
        expect(await waitForFrozen(server, true)).toMatchObject({ frozen: true, supported: true })

        // XTest synthetic input must keep working while the grab is active.
        const moved = await postJson(server, "/v1/computers/linux-host/actions", {
          action: "move",
          x: 4,
          y: 4,
          approve: true,
          approvedScopes: ["POINTER"],
          sessionId: "input-freeze-test",
        })
        expect(moved.status).toBe(200)
        expect(moved.body.ok).toBe(true)
        await waitForPointer(host, 4, 4)

        const released = await postJson(server, "/v1/input/release", { computerId: "linux-host" })
        expect(released.body).toEqual({ ok: true, frozen: false, releasedBy: "request" })
        expect(await waitForFrozen(server, false)).toMatchObject({ frozen: false, supported: true })
        expect(events.some((event) => event.type === "input.frozen")).toBe(true)
        expect(events.some((event) => event.type === "input.released")).toBe(true)
      } finally {
        await server.stop()
        host.dispose()
      }
    },
    20000,
  )

  test(
    "releases the grab on a double Escape",
    async () => {
      const host = new LinuxHostDriver()
      const server = await startOmniaServer({ drivers: [toServerDriver(host)] })
      try {
        const events: ServerEvent[] = []
        server.events.subscribe((event) => events.push(event))
        expect((await postJson(server, "/v1/input/freeze", { computerId: "linux-host" })).body.frozen).toBe(true)
        expect((await waitForFrozen(server, true)).frozen).toBe(true)

        const sender = spawnSync("python3", ["-c", ESCAPE_SENDER_SCRIPT], { timeout: 5000 })
        expect(sender.status).toBe(0)

        expect(await waitForFrozen(server, false)).toMatchObject({ frozen: false })
        expect(events.some((event) => event.type === "input.released" && event.data?.releasedBy === "escape")).toBe(true)

        const released = await postJson(server, "/v1/input/release", { computerId: "linux-host" })
        expect(released.body).toEqual({ ok: true, frozen: false, releasedBy: "escape" })
      } finally {
        await server.stop()
        host.dispose()
      }
    },
    20000,
  )
})
