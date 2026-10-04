import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { BrowserRuntime } from "./runtime"

const BRIDGE_ENV = ["OMNIA_BROWSER_WS", "OMNIA_BROWSER_TOKEN"] as const
const originalEnv = new Map<string, string | undefined>()

beforeAll(() => {
  for (const name of BRIDGE_ENV) {
    originalEnv.set(name, process.env[name])
    delete process.env[name]
  }
})
afterAll(() => {
  for (const name of BRIDGE_ENV) {
    const value = originalEnv.get(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})
afterEach(() => {
  for (const name of BRIDGE_ENV) delete process.env[name]
})

interface FakeBridge {
  readonly endpoint: string
  readonly token: string
  readonly connections: () => number
  readonly upgrades: () => number
  stop: () => void
}

interface BridgeSocket {
  send(data: string): void
}

function startBridge(options: { openFailures?: number } = {}): FakeBridge {
  const token = "bridge-token"
  let upgrades = 0
  let sequence = 1
  let active = "tab-1"
  let openFailures = options.openFailures ?? 0
  const tabs = new Map<string, { id: string; url: string }>([["tab-1", { id: "tab-1", url: "https://example.test/" }]])
  const sockets = new Set<BridgeSocket>()

  const respond = (method: string, params: Record<string, unknown>): unknown => {
    if (method === "Omnia.open" && openFailures > 0) {
      openFailures -= 1
      return { failure: { code: "open_timeout", message: "The embedded browser did not open a tab in time." } }
    }
    if (method === "Omnia.tabs") {
      return { tabs: [...tabs.values()].map((tab) => ({ ...tab, active: tab.id === active })) }
    }
    if (method === "Omnia.currentTab") return { tabId: active }
    if (method === "Omnia.activate") {
      active = String(params.tabId ?? "")
      return {}
    }
    if (method === "Omnia.open") {
      sequence += 1
      const id = `tab-${sequence}`
      const url = typeof params.url === "string" ? params.url : "about:blank"
      tabs.set(id, { id, url })
      active = id
      return { tab: { id, url } }
    }
    if (method === "Runtime.evaluate") {
      const expression = String(params.expression ?? "")
      if (expression.includes("readyState")) return { result: { value: JSON.stringify("complete") } }
      if (expression.includes("location.href")) return { result: { value: "https://example.test/final" } }
      return { result: { value: JSON.stringify(null) } }
    }
    return {}
  }

  const server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      if (new URL(request.url).searchParams.get("token") !== token) {
        return new Response("unauthorized", { status: 401 })
      }
      upgrades += 1
      if (srv.upgrade(request)) return undefined
      return new Response("upgrade required", { status: 426 })
    },
    websocket: {
      open(socket) {
        sockets.add(socket)
      },
      close(socket) {
        sockets.delete(socket)
      },
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as {
          id?: number
          method?: string
          params?: Record<string, unknown>
        }
        if (message.id === undefined || message.method === undefined) return
        const response = respond(message.method, message.params ?? {})
        if (typeof response === "object" && response !== null && "failure" in response) {
          const failure = (response as { failure: { code: string; message: string } }).failure
          socket.send(
            JSON.stringify({
              id: message.id,
              error: { code: -32000, message: failure.message, data: { code: failure.code } },
            }),
          )
          return
        }
        socket.send(JSON.stringify({ id: message.id, result: response }))
      },
    },
  })

  return {
    endpoint: `ws://127.0.0.1:${server.port}`,
    token,
    connections: () => sockets.size,
    upgrades: () => upgrades,
    stop: () => {
      void server.stop(true)
    },
  }
}

describe("browser runtime embedded bridge", () => {
  test("fails with not_available when no bridge is configured or the token is empty", async () => {
    const missing = new BrowserRuntime()
    await expect(missing.ensure()).rejects.toMatchObject({
      code: "not_available",
      message: "The embedded browser is not available.",
    })
    await expect(missing.status()).rejects.toMatchObject({ code: "not_available" })
    expect(missing.currentTab()).toBeUndefined()

    const tokenless = new BrowserRuntime({ embedded: { endpoint: "ws://127.0.0.1:1", token: "" } })
    await expect(tokenless.ensure()).rejects.toMatchObject({ code: "not_available" })
  })

  test("reads the endpoint and token from the environment", async () => {
    const bridge = startBridge()
    try {
      process.env.OMNIA_BROWSER_WS = bridge.endpoint
      process.env.OMNIA_BROWSER_TOKEN = bridge.token
      const runtime = new BrowserRuntime()
      const status = await runtime.status()
      expect(status).toMatchObject({ running: true, browser: "embedded", tabs: 1 })
      expect(status.endpoint).toBe(bridge.endpoint)
    } finally {
      bridge.stop()
    }
  })

  test("refuses blocked targets before connecting", async () => {
    const runtime = new BrowserRuntime({ embedded: { endpoint: "ws://127.0.0.1:1", token: "token" } })
    await expect(runtime.navigate("file:///etc/passwd")).rejects.toMatchObject({ code: "url_blocked" })
    await expect(runtime.open("http://127.0.0.1:8080/admin")).rejects.toMatchObject({ code: "url_blocked" })
    await expect(runtime.open("http://169.254.169.254/latest/meta-data")).rejects.toMatchObject({
      code: "url_blocked",
    })
    expect(runtime.currentTab()).toBeUndefined()
  })

  test("single-flights concurrent ensure calls over one connection", async () => {
    const bridge = startBridge()
    const runtime = new BrowserRuntime({ embedded: { endpoint: bridge.endpoint, token: bridge.token } })
    try {
      const results = await Promise.allSettled([runtime.ensure(), runtime.ensure()])
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"])
      expect(bridge.upgrades()).toBe(1)
      await runtime.ensure()
      expect(bridge.upgrades()).toBe(1)
    } finally {
      await runtime.closeRuntime()
      bridge.stop()
    }
  })

  test("delegates operations and reports the final URL", async () => {
    const bridge = startBridge()
    const runtime = new BrowserRuntime({ embedded: { endpoint: bridge.endpoint, token: bridge.token } })
    try {
      const opened = await runtime.open("https://example.test/start")
      expect(opened).toMatchObject({ id: "tab-2", url: "https://example.test/start" })
      expect(runtime.currentTab()).toBe("tab-2")

      const navigated = await runtime.navigate("https://example.test/start", opened.id)
      expect(navigated).toEqual({ id: "tab-2", url: "https://example.test/final" })

      expect((await runtime.tabs()).map((tab) => tab.id)).toEqual(["tab-1", "tab-2"])
    } finally {
      await runtime.closeRuntime()
      bridge.stop()
    }
  })

  test("an open after a failed handshake retries the bridge instead of staying stuck", async () => {
    const bridge = startBridge({ openFailures: 1 })
    const runtime = new BrowserRuntime({ embedded: { endpoint: bridge.endpoint, token: bridge.token } })
    try {
      await expect(runtime.open("https://late.test/")).rejects.toMatchObject({ code: "open_timeout" })
      expect(runtime.currentTab()).toBeUndefined()
      expect(await runtime.status()).toMatchObject({ running: true, tabs: 1 })

      const opened = await runtime.open("https://late.test/")
      expect(opened).toMatchObject({ id: "tab-2", url: "https://late.test/" })
      expect(runtime.currentTab()).toBe("tab-2")
      expect(await runtime.status()).toMatchObject({ running: true, tabs: 2 })
      expect((await runtime.tabs()).map((tab) => tab.id)).toEqual(["tab-1", "tab-2"])
    } finally {
      await runtime.closeRuntime()
      bridge.stop()
    }
  })

  test("never echoes the bridge token in status", async () => {
    const bridge = startBridge()
    const endpoint = `${bridge.endpoint}?token=${bridge.token}`
    const runtime = new BrowserRuntime({ embedded: { endpoint, token: bridge.token } })
    try {
      const status = await runtime.status()
      expect(status.endpoint).toBe(`${bridge.endpoint}?token=redacted`)
      expect(JSON.stringify(status)).not.toContain(bridge.token)
    } finally {
      await runtime.closeRuntime()
      bridge.stop()
    }
  })
})
