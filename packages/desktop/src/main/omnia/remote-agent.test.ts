import { recordGrabSubscription } from "./host-grab"
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync, lstatSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { handlers, setEncryptionAvailable } from "../../../test-support/electron"
import { activateTestUserData, useTestUserData } from "../../../test-support/user-data"

// remote-agent.ts imports Electron main-process modules that only exist inside
// a running app. Substitute the narrow surface it touches (app paths, safe
// storage, ipcMain) and capture registered handlers so the IPC layer can be
// driven the way the renderer would. The directory is this suite's own, so the
// real module and this suite agree on where its files live.
const userData = useTestUserData("omnia-remote-agent-")
mock.module("./server-host", () => ({
  createPlatformHostDriver: () => ({
    id: "test-host",
    backend: "test",
    getInfo: async () => ({ platform: "linux" }),
    capabilities: [],
    subscribeInputGrab: recordGrabSubscription,
  }),
}))

const remoteAgent = await import("./remote-agent")
const controlPlane = await import("./control-plane")

const serverCalls: Array<{ path: string; method: string; body?: unknown }> = []
mock.module("./server-call", () => ({
  serverCall: (path: string, method: string, body?: unknown) => {
    serverCalls.push({ path, method, body })
    return Promise.resolve({ ok: true })
  },
}))

const agentWorkingModule = await import("./agent-working")
const configPath = join(userData, "remote-agent.json")
const controlPlanePath = join(userData, "remote-agent-control-plane.json")
const sessionPath = join(userData, "auth-session.json")

beforeAll(() => {
  delete process.env.OMNIA_CONTROL_PLANE_URL
  remoteAgent.registerRemoteAgentIpcHandlers()
})

beforeEach(() => {
  activateTestUserData(userData)
  rmSync(configPath, { force: true })
  rmSync(controlPlanePath, { force: true })
  rmSync(sessionPath, { force: true })
  setEncryptionAvailable(true)
})

afterAll(() => {
  delete process.env.OMNIA_CONTROL_PLANE_URL
  delete process.env.OMNIA_TEST_USER_DATA
  rmSync(userData, { force: true, recursive: true })
})

describe("control-plane URL validation", () => {
  test("normalizes https and LAN addresses", () => {
    expect(remoteAgent.normalizeControlPlaneUrl("https://openfoodpantry.org/test1/omnia/")).toBe(
      "https://openfoodpantry.org/test1/omnia",
    )
    expect(remoteAgent.normalizeControlPlaneUrl("openfoodpantry.org/test1/omnia")).toBe(
      "https://openfoodpantry.org/test1/omnia",
    )
    expect(remoteAgent.normalizeControlPlaneUrl("http://127.0.0.1:4200")).toBe("http://127.0.0.1:4200")
    expect(remoteAgent.normalizeControlPlaneUrl("192.168.1.20:4200")).toBe("http://192.168.1.20:4200")
    expect(remoteAgent.normalizeControlPlaneUrl("http://10.0.0.5:4200/")).toBe("http://10.0.0.5:4200")
  })

  test("rejects public http, other schemes, and credentials", () => {
    expect(() => remoteAgent.normalizeControlPlaneUrl("http://example.com")).toThrow("https://")
    expect(() => remoteAgent.normalizeControlPlaneUrl("ftp://example.com")).toThrow("https://")
    expect(() => remoteAgent.normalizeControlPlaneUrl("https://user:pass@example.com")).toThrow("username")
    expect(() => remoteAgent.normalizeControlPlaneUrl("")).toThrow("Enter a control-plane URL.")
  })

  test("stores and clears the control plane through IPC", async () => {
    const get = handlers.get("computers-control-plane-get")!
    const set = handlers.get("computers-control-plane-set")!
    expect(await get({})).toEqual({ url: null })
    expect(() => set({}, "http://example.com")).toThrow("https://")
    expect(await set({}, "http://192.168.1.20:4200/")).toEqual({ url: "http://192.168.1.20:4200" })
    expect(await get({})).toEqual({ url: "http://192.168.1.20:4200" })
    expect(statSync(controlPlanePath).mode & 0o777).toBe(0o600)
    expect(await set({}, "")).toEqual({ url: null })
    expect(await get({})).toEqual({ url: null })
  })

  test("uses OMNIA_CONTROL_PLANE_URL as a default", async () => {
    process.env.OMNIA_CONTROL_PLANE_URL = "https://env.example.com/omnia"
    expect(await handlers.get("computers-control-plane-get")!({})).toEqual({ url: "https://env.example.com/omnia" })
    delete process.env.OMNIA_CONTROL_PLANE_URL
  })
})

describe("join resolution", () => {
  test("resolves a bare code against the configured control plane", () => {
    expect(remoteAgent.resolveJoinServer("abcd-efgh", "https://openfoodpantry.org/test1/omnia")).toEqual({
      code: "ABCD-EFGH",
      serverUrl: "https://openfoodpantry.org/test1/omnia",
    })
    expect(remoteAgent.resolveJoinServer("ABCDEFGH", "https://openfoodpantry.org/test1/omnia")).toEqual({
      code: "ABCD-EFGH",
      serverUrl: "https://openfoodpantry.org/test1/omnia",
    })
  })

  test("keeps the address from a URL#CODE input", () => {
    expect(remoteAgent.resolveJoinServer("192.168.1.5:42035#ABCD-EFGH", "https://openfoodpantry.org/test1/omnia")).toEqual({
      code: "ABCD-EFGH",
      serverUrl: "http://192.168.1.5:42035",
    })
  })

  test("defers bare codes to LAN discovery when no control plane is configured", () => {
    expect(remoteAgent.resolveJoinServer("ABCD-EFGH", undefined)).toEqual({ code: "ABCD-EFGH" })
  })

  test("rejects inputs that are not eight-character codes", () => {
    expect(() => remoteAgent.resolveJoinServer("nope", "https://openfoodpantry.org/test1/omnia")).toThrow("not valid")
    expect(() => remoteAgent.resolveJoinServer("https://openfoodpantry.org/test1/omnia", undefined)).toThrow("not valid")
  })

  test("joins with a bare code through the configured control plane", async () => {
    process.env.OMNIA_CONTROL_PLANE_URL = "https://openfoodpantry.org/test1/omnia"
    const requests: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url.includes("/remote/commands")) return await new Promise<Response>(() => {})
      return new Response(JSON.stringify({ ok: true, computerId: "joined-1", token: "joined-token" }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const result = await handlers.get("computers-pair-join")!({}, "abcd-efgh")
      expect(requests[0]).toBe("https://openfoodpantry.org/test1/omnia/v1/computers/pair/claim")
      expect(result).toMatchObject({
        computerId: "joined-1",
        serverUrl: "https://openfoodpantry.org/test1/omnia",
      })
      const stored = JSON.parse(readFileSync(configPath, "utf8")) as { token: string; encrypted?: boolean }
      expect(stored.encrypted).toBe(true)
      expect(stored.token).not.toBe("joined-token")
      expect(remoteAgent.loadRemoteAgentConfig()?.token).toBe("joined-token")
      await handlers.get("computers-pair-leave")!({})
    } finally {
      delete process.env.OMNIA_CONTROL_PLANE_URL
      globalThis.fetch = originalFetch
    }
  })
})

describe("credential storage", () => {
  test("encrypts the pairing token and decrypts it on load", () => {
    remoteAgent.persistRemoteAgentConfig({
      serverUrl: "https://openfoodpantry.org/test1/omnia",
      computerId: "c1",
      token: "secret-token",
    })
    const stored = JSON.parse(readFileSync(configPath, "utf8")) as { token: string; encrypted?: boolean }
    expect(stored.encrypted).toBe(true)
    expect(stored.token).not.toBe("secret-token")
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
    expect(remoteAgent.loadRemoteAgentConfig()).toEqual({
      serverUrl: "https://openfoodpantry.org/test1/omnia",
      computerId: "c1",
      token: "secret-token",
      encrypted: true,
    })
  })

  test("encrypts a plaintext token on the next persist", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ serverUrl: "https://openfoodpantry.org/test1/omnia", computerId: "c2", token: "legacy-token" }),
      { mode: 0o600 },
    )
    const loaded = remoteAgent.loadRemoteAgentConfig()
    expect(loaded?.token).toBe("legacy-token")
    expect(loaded?.encrypted).toBeUndefined()
    remoteAgent.persistRemoteAgentConfig(loaded)
    const stored = JSON.parse(readFileSync(configPath, "utf8")) as { token: string; encrypted?: boolean }
    expect(stored.encrypted).toBe(true)
    expect(stored.token).not.toBe("legacy-token")
    expect(remoteAgent.loadRemoteAgentConfig()?.token).toBe("legacy-token")
  })

  test("falls back to plaintext with owner-only permissions when encryption is unavailable", () => {
    setEncryptionAvailable(false)
    remoteAgent.persistRemoteAgentConfig({
      serverUrl: "http://192.168.1.20:4200",
      computerId: "c3",
      token: "plain-token",
    })
    const stored = JSON.parse(readFileSync(configPath, "utf8")) as { token: string; encrypted?: boolean }
    expect(stored.encrypted).toBeUndefined()
    expect(stored.token).toBe("plain-token")
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
    expect(remoteAgent.loadRemoteAgentConfig()?.token).toBe("plain-token")
  })
})

describe("remote key safety", () => {
  const keyPath = join(userData, "remote-key.json")

  // Registration always needs a signed-in control plane, and the key file is
  // shared state between tests that only this suite writes.
  function signedIn(): void {
    rmSync(keyPath, { force: true })
    writeFileSync(sessionPath, JSON.stringify({ url: "https://cp.example.com", clientToken: "client-token" }), {
      mode: 0o600,
    })
  }

  test("refuses to store the private key when no keychain is available", async () => {
    signedIn()
    setEncryptionAvailable(false)
    process.env.OMNIA_SAFE_STORAGE = "0"
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch

    try {
      // safeStorage is unavailable by default on macOS and on Linux without a
      // keyring; the private key must never reach disk in the clear anyway.
      await expect(remoteAgent.registerWithControlPlane()).rejects.toThrow("keychain")
      expect(existsSync(keyPath)).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      delete process.env.OMNIA_SAFE_STORAGE
      setEncryptionAvailable(true)
      rmSync(keyPath, { force: true })
    }
  })

  test("refuses to write the remote key through a symlink", async () => {
    signedIn()
    // A link with nothing behind it: the key pair is created, and the save that
    // would follow the link is refused instead.
    const target = join(userData, "attacker.json")
    symlinkSync(target, keyPath)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch

    try {
      await expect(remoteAgent.registerWithControlPlane()).rejects.toThrow("symlink")
      expect(existsSync(target)).toBe(false)
      expect(lstatSync(keyPath).isSymbolicLink()).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      rmSync(keyPath, { force: true })
    }
  })

  test("refuses to write the pairing config through a symlink", () => {
    const attacker = join(userData, "attacker-config.json")
    writeFileSync(attacker, "{}")
    symlinkSync(attacker, configPath)

    expect(() =>
      remoteAgent.persistRemoteAgentConfig({ serverUrl: "http://192.168.1.20:4200", computerId: "c9", token: "t" }),
    ).toThrow("symlink")
    expect(readFileSync(attacker, "utf8")).toBe("{}")
    rmSync(configPath, { force: true })
  })
})

describe("control-plane registration", () => {
  interface CapturedRequest {
    url: string
    method: string
    authorization: string | null
    body: string
  }

  function captureFetch(requests: CapturedRequest[]): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({
        url,
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? init.body : "",
      })
      if (url.endsWith("/v1/computers/register")) {
        return new Response(JSON.stringify({ ok: true, computerId: "cp-1", token: "cp-token" }), { status: 200 })
      }
      if (url.includes("/remote/commands")) return await new Promise<Response>(() => {})
      return new Response(JSON.stringify({ ok: false }), { status: 404 })
    }) as unknown as typeof fetch
  }

  test("registers the local runtime and starts the signed remote agent", async () => {
    process.env.OMNIA_CONTROL_PLANE_URL = "https://cp.example.com"
    writeFileSync(sessionPath, JSON.stringify({ url: "https://cp.example.com", clientToken: "client-token" }), {
      mode: 0o600,
    })
    const requests: CapturedRequest[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = captureFetch(requests)
    try {
      expect(await remoteAgent.registerWithControlPlane()).toEqual({
        computerId: "cp-1",
        serverUrl: "https://cp.example.com",
      })
      const register = requests.find((request) => request.url.endsWith("/v1/computers/register"))
      expect(register?.authorization).toBe("Bearer client-token")
      const body = JSON.parse(register?.body ?? "{}") as Record<string, unknown>
      expect(body.platform).toBe("linux")
      expect(typeof body.name).toBe("string")
      expect(body).not.toHaveProperty("architecture")
      expect(body.capabilities).toEqual([])
      expect((body.publicKey as { kty?: string }).kty).toBe("OKP")

      await Bun.sleep(20)
      const poll = requests.find((request) => request.url.includes("/v1/computers/cp-1/remote/commands"))
      expect(poll?.authorization).toBe("Bearer cp-token")
      expect(await handlers.get("computers-pair-status")!({})).toEqual({
        paired: true,
        computerId: "cp-1",
        serverUrl: "https://cp.example.com",
        connected: true,
      })
      expect(process.env.OMNIA_SERVER_URL).toBeUndefined()
      expect(existsSync(join(userData, "server.json"))).toBe(false)
    } finally {
      delete process.env.OMNIA_CONTROL_PLANE_URL
      globalThis.fetch = originalFetch
    }
  })

  test("stops the registered agent after sign-out", async () => {
    process.env.OMNIA_CONTROL_PLANE_URL = "https://cp.example.com"
    writeFileSync(sessionPath, JSON.stringify({ url: "https://cp.example.com", clientToken: "client-token" }), {
      mode: 0o600,
    })
    const requests: CapturedRequest[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = captureFetch(requests)
    try {
      await remoteAgent.syncControlPlaneRegistration()
      expect(requests.some((request) => request.url.endsWith("/v1/computers/register"))).toBe(true)
      rmSync(sessionPath, { force: true })
      await remoteAgent.syncControlPlaneRegistration()
      expect(await handlers.get("computers-pair-status")!({})).toEqual({ paired: false })
    } finally {
      delete process.env.OMNIA_CONTROL_PLANE_URL
      globalThis.fetch = originalFetch
    }
  })
})

describe("control-plane client", () => {
  test("errors clearly when no session is stored", async () => {
    expect(controlPlane.isReady()).toBe(false)
    await expect(controlPlane.fetchControlPlane("/v1/computers")).rejects.toThrow("Sign in")
    await expect(controlPlane.controlPlaneCall("/v1/computers", "GET")).rejects.toThrow("Sign in")
  })

  // The sidecar is re-forked when this value changes, so a rotated token has to
  // read as a different session even though the URL is unchanged.
  test("fingerprints the stored session, not just its URL", () => {
    expect(controlPlane.controlPlaneFingerprint()).toBeUndefined()
    writeFileSync(sessionPath, JSON.stringify({ url: "https://cp.example.com", clientToken: "client-token" }), {
      mode: 0o600,
    })
    expect(controlPlane.controlPlaneFingerprint()).toBe("https://cp.example.com\nclient-token")
    writeFileSync(sessionPath, JSON.stringify({ url: "https://cp.example.com", clientToken: "rotated-token" }), {
      mode: 0o600,
    })
    expect(controlPlane.controlPlaneFingerprint()).toBe("https://cp.example.com\nrotated-token")
    rmSync(sessionPath, { force: true })
    expect(controlPlane.controlPlaneFingerprint()).toBeUndefined()
  })

  test("adds the stored client token to the configured control plane", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push({ url: request.url, authorization: request.headers.get("authorization") })
        return Response.json({ ok: true, computers: [] })
      },
    })
    try {
      process.env.OMNIA_CONTROL_PLANE_URL = `http://127.0.0.1:${server.port}`
      writeFileSync(sessionPath, JSON.stringify({ url: "https://ignored.example.com", clientToken: "client-token" }), {
        mode: 0o600,
      })
      expect(controlPlane.isReady()).toBe(true)
      const response = await controlPlane.fetchControlPlane("/v1/computers")
      expect(response.status).toBe(200)
      expect(requests).toEqual([
        { url: `http://127.0.0.1:${server.port}/v1/computers`, authorization: "Bearer client-token" },
      ])
      expect(await controlPlane.controlPlaneCall("/v1/computers", "GET")).toEqual({ ok: true, computers: [] })
    } finally {
      delete process.env.OMNIA_CONTROL_PLANE_URL
      server.stop(true)
    }
  })

  test("falls back to the URL stored with the session", async () => {
    const requests: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(request.url)
        return Response.json({ ok: true })
      },
    })
    try {
      writeFileSync(sessionPath, JSON.stringify({ url: `http://127.0.0.1:${server.port}/`, clientToken: "client-token" }), {
        mode: 0o600,
      })
      await controlPlane.fetchControlPlane("/v1/status")
      expect(requests).toEqual([`http://127.0.0.1:${server.port}/v1/status`])
    } finally {
      server.stop(true)
    }
  })

  test("decrypts a session stored behind a safeStorage payload", async () => {
    const authorization: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        authorization.push(request.headers.get("authorization") ?? "")
        return Response.json({ ok: true })
      },
    })
    try {
      process.env.OMNIA_CONTROL_PLANE_URL = `http://127.0.0.1:${server.port}`
      const payload = Buffer.from(
        `omnia-test:${JSON.stringify({ url: "https://ignored.example.com", clientToken: "client-token" })}`,
        "utf8",
      ).toString("base64")
      writeFileSync(sessionPath, JSON.stringify({ encrypted: true, payload }), { mode: 0o600 })
      await controlPlane.fetchControlPlane("/v1/status")
      expect(authorization).toEqual(["Bearer client-token"])
    } finally {
      delete process.env.OMNIA_CONTROL_PLANE_URL
      server.stop(true)
    }
  })

  test("surfaces the control-plane error message", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ ok: false, error: "client_token_required" }, { status: 401 })
      },
    })
    try {
      process.env.OMNIA_CONTROL_PLANE_URL = `http://127.0.0.1:${server.port}`
      writeFileSync(sessionPath, JSON.stringify({ url: "https://ignored.example.com", clientToken: "client-token" }), {
        mode: 0o600,
      })
      await expect(controlPlane.controlPlaneCall("/v1/computers", "GET")).rejects.toThrow("client_token_required")
    } finally {
      delete process.env.OMNIA_CONTROL_PLANE_URL
      server.stop(true)
    }
  })
})

describe("native action tracking", () => {
  type Driver = Parameters<typeof remoteAgent.withNativeActionTracking>[0]

  // A real class, like the production drivers: prototype methods and private
  // state both matter, because a wrapper that copies the instance (losing
  // prototype methods) or re-creates it (skipping the constructor and leaving
  // private fields unset) breaks run_command.
  class FakeDriver {
    readonly id = "test-driver"
    readonly backend = "test"
    private readonly typed: string[] = []
    constructor(private readonly exec: (action: unknown) => Promise<{ success: boolean }>) {}
    getInfo() {
      return Promise.resolve({ id: this.id, name: "test", platform: "linux", backend: this.backend })
    }
    observe() {
      return Promise.resolve({ id: "obs-1", elements: [{ id: "e1", role: "window", name: "Test" }] })
    }
    find(request: { query: string }) {
      return Promise.resolve({ query: request.query, matches: [] })
    }
    execute(action: unknown) {
      return this.exec(action)
    }
    runCommand(request: { command: string }) {
      this.typed.push(request.command)
      return Promise.resolve({
        success: true,
        status: "success" as const,
        message: "ok",
        command: { exitCode: 0, stdout: this.typed.join("\n"), stderr: "" },
      })
    }
    revalidateTarget() {
      return Promise.resolve({ valid: true })
    }
  }

  const fakeDriver = (execute: (action: unknown) => Promise<{ success: boolean }>): Driver =>
    new FakeDriver(execute) as unknown as Driver

  test("keeps prototype methods, getters, and private state intact", async () => {
    const events: string[] = []
    const tracked = remoteAgent.withNativeActionTracking(fakeDriver(async () => ({ success: true })), {
      started: () => events.push("started"),
      ended: () => events.push("ended"),
    })
    expect(typeof tracked.observe).toBe("function")
    expect(typeof tracked.find).toBe("function")
    const observation = await tracked.observe()
    expect(observation.elements?.[0]?.id).toBe("e1")
    const result = await tracked.runCommand!({ command: "echo alive" } as never)
    expect(result.success).toBe(true)
    expect(result.command?.stdout).toEqual("echo alive")
    expect(events).toEqual(["started", "ended"])
    expect(tracked.id).toBe("test-driver")
  })

  test("read paths stay untracked so the input freeze only covers actions", async () => {
    const events: string[] = []
    const tracked = remoteAgent.withNativeActionTracking(fakeDriver(async () => ({ success: true })), {
      started: () => events.push("started"),
      ended: () => events.push("ended"),
    })
    await tracked.observe()
    await tracked.find({ query: "anything" } as never)
    expect(events).toEqual([])
  })

  test("notifies start and end around mutating driver calls only", async () => {
    const events: string[] = []
    const observer = {
      started: () => events.push("started"),
      ended: (ok: boolean) => events.push(ok ? "ended-ok" : "ended-fail"),
    }
    const driver = fakeDriver(async () => ({ success: true }))
    const tracked = remoteAgent.withNativeActionTracking(
      Object.assign(driver, { runCommand: async () => ({ success: false }) }),
      observer,
    )
    await tracked.execute({ type: "click" } as never)
    await tracked.runCommand!({ command: "ls" } as never)
    await tracked.observe()
    await tracked.find({ query: "x" } as never)
    expect(events).toEqual(["started", "ended-ok", "started", "ended-fail"])
  })

  test("reports failure when the driver throws and rethrows", async () => {
    const events: string[] = []
    const tracked = remoteAgent.withNativeActionTracking(
      fakeDriver(async () => {
        throw new Error("boom")
      }),
      { started: () => events.push("started"), ended: () => events.push("ended") },
    )
    await expect(tracked.execute({ type: "click" } as never)).rejects.toThrow("boom")
    expect(events).toEqual(["started", "ended"])
  })

  test("returns the driver untouched without an observer", () => {
    const driver = fakeDriver(async () => ({ success: true }))
    expect(remoteAgent.withNativeActionTracking(driver, undefined)).toBe(driver)
  })

  test("the observer defaults to the registered one", async () => {
    const events: string[] = []
    remoteAgent.setNativeActionObserver({ started: () => events.push("s"), ended: () => events.push("e") })
    try {
      const tracked = remoteAgent.withNativeActionTracking(fakeDriver(async () => ({ success: true })))
      await tracked.execute({ type: "click" } as never)
      expect(events).toEqual(["s", "e"])
    } finally {
      remoteAgent.setNativeActionObserver(undefined)
    }
  })
})

describe("agent working input freeze", () => {
  test("posts freeze and release with the registered computer id", async () => {
    serverCalls.length = 0
    const working = agentWorkingModule.createAgentWorking({ computerId: () => "computer-9" })
    try {
      working.notifyActionStart()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(serverCalls[0]).toEqual({
        path: "/v1/input/freeze",
        method: "POST",
        body: { computerId: "computer-9", reason: "agent task" },
      })
      // The grab stays held while native actions keep landing inside the
      // window; only teardown releases it.
      working.notifyActionEnd(true)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(serverCalls.some((call) => call.path === "/v1/input/release")).toBe(false)
    } finally {
      working.destroy()
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    const release = serverCalls.find((call) => call.path === "/v1/input/release")
    expect(release).toEqual({ path: "/v1/input/release", method: "POST", body: { computerId: "computer-9" } })
  })

  test("omits computerId when no runtime is registered", async () => {
    serverCalls.length = 0
    const working = agentWorkingModule.createAgentWorking({})
    try {
      working.notifyActionStart()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(serverCalls[0]).toEqual({ path: "/v1/input/freeze", method: "POST", body: { reason: "agent task" } })
    } finally {
      working.destroy()
    }
  })
})

describe("remote browser scroll dispatch", () => {
  test("scroll and scrollPosition reach the embedded runtime with intact params", async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const runtime = {
      scroll: async (options: unknown) => {
        calls.push({ method: "scroll", params: options })
      },
      scrollPosition: async (options: unknown) => {
        calls.push({ method: "scrollPosition", params: options })
        return { x: 0, y: 800 }
      },
    }
    const dispatch = remoteAgent.createRemoteBrowserHandler(
      runtime as unknown as Parameters<typeof remoteAgent.createRemoteBrowserHandler>[0],
    )
    await dispatch({
      operation: "scroll",
      params: { input: { tabId: "tab-1", deltaY: 800, x: 400, y: 300 } },
    })
    expect(calls).toEqual([
      { method: "scroll", params: { tabId: "tab-1", deltaY: 800, x: 400, y: 300 } },
    ])
    await expect(
      dispatch({ operation: "scrollPosition", params: { input: { tabId: "tab-1" } } }),
    ).resolves.toEqual({ x: 0, y: 800 })
    expect(calls[1]).toEqual({ method: "scrollPosition", params: { tabId: "tab-1" } })
  })
})
