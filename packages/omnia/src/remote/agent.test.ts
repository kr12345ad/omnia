import { describe, expect, test } from "bun:test"
import type { PlanId } from "../billing/plans"
import type { HostDriver } from "../daemon/host-driver"
import { RemoteAgent } from "./agent"
import { REMOTE_SESSION_LIMIT_CODE } from "./entitlement"
import { createRemoteKeyPair, type RemoteKeyPair } from "./keys"
import { remoteRequestPath, verifyRemoteSignature } from "./signing"

const driver: HostDriver = {
  id: "host-1",
  backend: "test",
  capabilities: [],
  getInfo: async () => ({ id: "host-1", name: "Host", platform: "linux", connected: true }),
  observe: async () => ({ id: "obs-1", elements: [] }),
  find: async () => ({ matches: [] }),
  execute: async () => ({ success: true, status: "success", message: "ok" }),
  revalidateTarget: async () => ({ valid: true }),
}

interface CapturedRequest {
  readonly url: string
  readonly headers: Headers
}

function fakeFetch(
  handler: (input: URL | RequestInfo, init: RequestInit | undefined) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: () => undefined })
}

describe("remote agent signing", () => {
  test("signs polls with a storage-backed key pair", async () => {
    let stored: RemoteKeyPair | undefined
    const requests: CapturedRequest[] = []
    const http = fakeFetch(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      requests.push({ url, headers: new Headers(init?.headers) })
      if (requests.length === 1) {
        return new Response(JSON.stringify({ ok: true, command: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ ok: false }), { status: 401 })
    })
    const agent = new RemoteAgent({
      serverUrl: "http://127.0.0.1:9999",
      computerId: "remote-1",
      token: "token-1",
      driver,
      fetch: http,
      keyStorage: {
        load: () => stored,
        save: (keys) => {
          stored = keys
        },
      },
      now: () => 4000,
    })
    agent.start()
    while (agent.running) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(requests).toHaveLength(2)
    const first = requests[0]!
    expect(first.headers.get("x-omnia-key-id")).toBe("remote-1")
    expect(first.headers.get("x-omnia-timestamp")).toBe("4000")
    expect(stored).toBeDefined()
    expect(
      verifyRemoteSignature(stored!.publicKey, {
        method: "GET",
        path: remoteRequestPath(first.url),
        timestampMs: 4000,
        signature: first.headers.get("x-omnia-signature") ?? "",
      }),
    ).toBe(true)
    expect(
      verifyRemoteSignature(stored!.publicKey, {
        method: "GET",
        path: "/v1/computers/remote-1/remote/commands?wait=tampered",
        timestampMs: 4000,
        signature: first.headers.get("x-omnia-signature") ?? "",
      }),
    ).toBe(false)
  })

  test("stays bearer-only when no keys are configured", async () => {
    const requests: CapturedRequest[] = []
    const http = fakeFetch(async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) })
      return new Response(JSON.stringify({ ok: false }), { status: 401 })
    })
    const agent = new RemoteAgent({
      serverUrl: "http://127.0.0.1:9999",
      computerId: "remote-1",
      token: "token-1",
      driver,
      fetch: http,
    })
    agent.start()
    while (agent.running) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(requests).toHaveLength(1)
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer token-1")
    expect(requests[0]!.headers.get("x-omnia-signature")).toBeNull()
  })

  test("signs with a strictly increasing timestamp so the server cannot read it as a replay", async () => {
    const keys = createRemoteKeyPair()
    const timestamps: number[] = []
    const http = fakeFetch(async (input, init) => {
      timestamps.push(Number(new Headers(init?.headers).get("x-omnia-timestamp")))
      // An empty poll answer keeps the loop going straight into the next request.
      if (timestamps.length === 1) {
        return new Response(JSON.stringify({ ok: true, command: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ ok: false }), { status: 401 })
    })
    const agent = new RemoteAgent({
      serverUrl: "http://127.0.0.1:9999",
      computerId: "remote-1",
      token: "token-1",
      driver,
      fetch: http,
      keys,
      // A frozen clock: two requests would otherwise carry the same millisecond,
      // which the server refuses as a replay of the first.
      now: () => 4000,
    })
    agent.start()
    while (agent.running) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(timestamps.length).toBeGreaterThanOrEqual(2)
    expect(timestamps[1]).toBeGreaterThan(timestamps[0]!)
  })
})

describe("remote agent stop", () => {
  const command = { id: "cmd-1", method: "execute", params: { type: "click", x: 1, y: 2 } }

  function stoppingAgent(
    fetch: (init: RequestInit | undefined) => Promise<Response>,
    executed: string[],
  ): RemoteAgent {
    return new RemoteAgent({
      serverUrl: "http://127.0.0.1:9999",
      computerId: "remote-1",
      token: "token-1",
      driver: {
        ...driver,
        execute: async (action) => {
          executed.push(action.type)
          return { success: true, status: "success", message: "ok" }
        },
      },
      fetch: fakeFetch(async (_input, init) => fetch(init)),
    })
  }

  test("aborts the poll in flight so no command can arrive after stop", async () => {
    const executed: string[] = []
    const signals: AbortSignal[] = []
    const agent = stoppingAgent(async (init) => {
      signals.push(init?.signal as AbortSignal)
      return new Promise<Response>((_resolve, reject) => {
        signals[0]!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    }, executed)
    agent.start()
    while (signals.length === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    agent.stop()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(agent.running).toBe(false)
    expect(signals).toHaveLength(1)
    expect(signals[0]!.aborted).toBe(true)
    expect(executed).toEqual([])
  })

  test("never runs a command that lands after stop", async () => {
    const executed: string[] = []
    const released: Array<() => void> = []
    const agent = stoppingAgent(async () => {
      // The long-poll answers only when the test releases it, so the command
      // is always in flight when stop() lands.
      await new Promise<void>((resolve) => released.push(resolve))
      return new Response(JSON.stringify({ ok: true, command }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }, executed)
    agent.start()
    while (released.length === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    agent.stop()
    released[0]!()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(agent.running).toBe(false)
    expect(executed).toEqual([])
  })
})

describe("remote session ceiling", () => {
  const command = { id: "cmd-1", method: "execute", params: { type: "click", x: 1, y: 2 } }
  type Posted = { id: string; ok: boolean; error?: string; code?: string }

  interface SessionAgentInput {
    readonly plan?: PlanId
    readonly executed: string[]
    readonly posted: Posted[]
    readonly logs: string[]
  }

  /**
   * An agent on a clock the test owns.
   *
   * The first poll answers with one command after jumping the clock past the
   * ceiling; every later poll parks forever, which is what a real long-poll
   * looks like and keeps the loop from spinning. `control` lets a test rewind
   * to a fresh window without rebuilding the agent.
   */
  function sessionAgent(input: SessionAgentInput) {
    const control = { jumpMs: 121 * 60_000, deliver: true, polls: 0 }
    let clock = 10_000
    const http = fakeFetch(async (request, init) => {
      const url = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url
      if (url.includes("/remote/commands")) {
        control.polls += 1
        clock += control.jumpMs
        if (control.polls > 1) return new Promise<Response>(() => {})
        return new Response(JSON.stringify({ ok: true, command: control.deliver ? command : null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/remote/results")) {
        input.posted.push(JSON.parse(String(init?.body)) as Posted)
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: false }), { status: 401 })
    })
    return {
      control,
      agent: new RemoteAgent({
        serverUrl: "http://127.0.0.1:9999",
        computerId: "remote-1",
        token: "token-1",
        driver: {
          ...driver,
          execute: async (action) => {
            input.executed.push(action.type)
            return { success: true, status: "success", message: "ok" }
          },
        },
        fetch: http,
        now: () => clock,
        log: (message) => input.logs.push(message),
        ...(input.plan === undefined ? {} : { plan: input.plan }),
      }),
    }
  }

  function recorder() {
    return { executed: [] as string[], posted: [] as Posted[], logs: [] as string[] }
  }

  /**
   * `running` is a getter, and a `while` on it narrows the property to false for
   * the rest of the test, so the assertions read it through a call instead.
   */
  function isRunning(agent: RemoteAgent): boolean {
    return agent.running
  }

  test("refuses the command that lands after the free ceiling and ends the session", async () => {
    const seen = recorder()
    const { agent } = sessionAgent({ plan: "free", ...seen })
    agent.start()
    while (agent.running) await new Promise((resolve) => setTimeout(resolve, 1))

    expect(seen.executed).toEqual([])
    expect(seen.posted).toHaveLength(1)
    expect(seen.posted[0]).toMatchObject({ id: "cmd-1", ok: false, code: REMOTE_SESSION_LIMIT_CODE })
    expect(seen.posted[0]!.error).toContain("120 minute limit for the free plan")
    expect(seen.posted[0]!.error).toContain("Reconnect to start a new session")
    expect(agent.sessionEnd).toMatchObject({ code: REMOTE_SESSION_LIMIT_CODE, minutes: 120, resumable: true })
    expect(seen.logs.join("\n")).toContain("120 minute limit for the free plan")
    agent.stop()
  })

  test("ends the session with the same reason when no command was waiting", async () => {
    const seen = recorder()
    const { agent, control } = sessionAgent({ plan: "free", ...seen })
    control.deliver = false
    agent.start()
    while (agent.running) await new Promise((resolve) => setTimeout(resolve, 1))

    expect(seen.executed).toEqual([])
    expect(seen.posted).toEqual([])
    expect(agent.sessionEnd).toMatchObject({ minutes: 120, resumable: true })
    expect(seen.logs.join("\n")).toContain("Reconnect to start a new session")
    agent.stop()
  })

  test("a plan that could not be determined still runs under the free ceiling", async () => {
    const seen = recorder()
    const { agent } = sessionAgent(seen)
    agent.start()
    while (agent.running) await new Promise((resolve) => setTimeout(resolve, 1))

    expect(seen.executed).toEqual([])
    expect(seen.posted[0]!.code).toBe(REMOTE_SESSION_LIMIT_CODE)
    expect(seen.posted[0]!.error).toContain("The plan could not be confirmed")
    agent.stop()
  })

  test("a paid plan runs the command past the free ceiling", async () => {
    const seen = recorder()
    const { agent } = sessionAgent({ plan: "pro", ...seen })
    agent.start()
    while (seen.posted.length === 0) await new Promise((resolve) => setTimeout(resolve, 1))

    expect(seen.executed).toEqual(["click"])
    expect(seen.posted[0]).toMatchObject({ id: "cmd-1", ok: true })
    expect(agent.sessionEnd).toBeUndefined()
    expect(isRunning(agent)).toBe(true)
    agent.stop()
  })

  test("starting again after the ceiling resumes the same pairing", async () => {
    const seen = recorder()
    const { agent, control } = sessionAgent({ plan: "free", ...seen })
    agent.start()
    while (agent.running) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(agent.sessionEnd).toBeDefined()

    // Only the loop closed: the pairing, token and key are untouched, so the
    // same agent opens a fresh window and the command runs.
    const before = seen.posted.length
    control.jumpMs = 0
    control.polls = 0
    agent.start()
    while (seen.posted.length === before) await new Promise((resolve) => setTimeout(resolve, 1))

    expect(isRunning(agent)).toBe(true)
    expect(agent.sessionEnd).toBeUndefined()
    expect(seen.posted.slice(before)).toMatchObject([{ id: "cmd-1", ok: true }])
    expect(seen.executed).toEqual(["click"])
    agent.stop()
  })

  test("stop() is still final: a stopped agent does not resume", async () => {
    const seen = recorder()
    const { agent } = sessionAgent({ plan: "pro", ...seen })
    agent.start()
    agent.stop()
    agent.start()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(isRunning(agent)).toBe(false)
    expect(seen.executed).toEqual([])
  })
})
