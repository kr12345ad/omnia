import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { SwitchComputerTool } from "@/tool/computer/switch"
import { ComputerActTool } from "@/tool/computer/act"
import { ComputerObserveTool } from "@/tool/computer/observe"
import {
  COMPUTER_SELECTION_METADATA_KEY,
  computerId,
  configFromEnv,
  controlPlaneKey,
  selectionFromMetadata,
} from "@/tool/computer/client"
import { testEffect } from "../lib/effect"

type Computer = { id: string; name: string; platform: string; connected: boolean }
const devices: Computer[] = [
  { id: "local", name: "Linux tower", platform: "linux", connected: true },
  { id: "remote-mac", name: "MacBook", platform: "darwin", connected: true },
  { id: "remote-offline", name: "Office PC", platform: "win32", connected: false },
]
let computers: Computer[] = devices
const requests: Array<{ url: string; body?: string }> = []
const http = HttpClient.make((request) => {
  const value = request.body.toJSON()
  const body = typeof value === "object" && value !== null && "body" in value && typeof value.body === "string"
    ? value.body : undefined
  requests.push({ url: request.url, body })
  const response = request.url.endsWith("/v1/computers")
    ? { ok: true, computers }
    : request.url.endsWith("/observe")
      ? { ok: true, observation: { id: "fresh-observation", elements: [] } }
      : { ok: true, result: { success: true, status: "success", message: "Launched.", verification: { status: "verified" } } }
  return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(response), {
    headers: { "content-type": "application/json" },
  })))
})

const layer = LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node, Session.node, SessionProjector.node]), [
  [httpClient, Layer.succeed(HttpClient.HttpClient, http)],
])
const it = testEffect(layer)

function withEnv<A, E, R>(run: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = [process.env.OMNIA_SERVER_URL, process.env.OMNIA_SERVER_TOKEN, process.env.OMNIA_COMPUTER_ID]
      process.env.OMNIA_SERVER_URL = "http://127.0.0.1:9"
      process.env.OMNIA_SERVER_TOKEN = "switch-test-token"
      process.env.OMNIA_COMPUTER_ID = "local"
      computers = devices
      requests.length = 0
      return previous
    }),
    run,
    (previous) => Effect.sync(() => {
      for (const [index, key] of ["OMNIA_SERVER_URL", "OMNIA_SERVER_TOKEN", "OMNIA_COMPUTER_ID"].entries()) {
        if (previous[index] === undefined) delete process.env[key]
        else process.env[key] = previous[index]
      }
      computers = devices
    }),
  )
}

function context(sessionID: Tool.Context["sessionID"], ask: Tool.Context["ask"] = () => Effect.void): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make("msg_switch"),
    callID: "switch-test",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask,
  }
}

function failure<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) throw new Error("Expected a refused switch")
    return String(Cause.squash(exit.cause))
  })
}

describe("switch_computer", () => {
  it.instance("lists devices without changing the target or requesting pointer permissions", () => withEnv(() =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ metadata: { mode: "work", untouched: "kept" } })
      const tool = yield* Tool.init(yield* SwitchComputerTool)
      const asked: string[] = []
      const result = yield* tool.execute({}, context(session.id, (input) => Effect.sync(() => { asked.push(input.permission) })))
      expect(result.metadata.switched).toBe(false)
      expect(JSON.parse(result.output).computers).toEqual(devices)
      expect(asked).toEqual([])
      expect((yield* sessions.get(session.id)).metadata).toEqual({ mode: "work", untouched: "kept" })
      const controlRequests = requests.filter((request) => request.url.startsWith("http://127.0.0.1:9/"))
      expect(controlRequests).toEqual([{ url: "http://127.0.0.1:9/v1/computers", body: undefined }])
    }),
  ))

  it.instance("persists a switch and routes observe and launch_app to that device only", () => withEnv(() =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ metadata: { mode: "work", untouched: "kept" } })
      const other = yield* sessions.create({ metadata: { mode: "work" } })
      const switcher = yield* Tool.init(yield* SwitchComputerTool)
      const result = yield* switcher.execute({ computerId: "remote-mac" }, context(session.id))
      expect(result.metadata.computerId).toBe("remote-mac")
      expect(result.metadata.previousComputerId).toBe("local")
      const config = yield* configFromEnv()
      const saved = yield* sessions.get(session.id)
      expect(saved.metadata?.mode).toBe("work")
      expect(saved.metadata?.untouched).toBe("kept")
      expect(saved.metadata?.[COMPUTER_SELECTION_METADATA_KEY]).toEqual({ id: "remote-mac", server: controlPlaneKey(config) })
      expect(JSON.stringify(saved.metadata)).not.toContain("switch-test-token")
      expect(yield* computerId(http, config, session.id)).toBe("remote-mac")
      expect(yield* computerId(http, config, other.id)).toBe("local")
      const observe = yield* Tool.init(yield* ComputerObserveTool)
      yield* observe.execute({}, context(session.id))
      const act = yield* Tool.init(yield* ComputerActTool)
      yield* act.execute({ action: "launch_app", app: "Safari" }, context(session.id))
      expect(requests.some((request) => request.url.endsWith("/v1/computers/remote-mac/observe"))).toBe(true)
      const launch = requests.find((request) => request.url.endsWith("/v1/computers/remote-mac/actions"))
      expect(JSON.parse(launch!.body!)).toMatchObject({ action: "launch_app", app: "Safari", sessionId: session.id })
      expect(requests.some((request) => request.url.includes("/v1/computers/local/"))).toBe(false)
      // Re-initializing the switch tool sees the same durable session metadata.
      const reloaded = yield* Tool.init(yield* SwitchComputerTool)
      const listed = yield* reloaded.execute({}, context(session.id))
      expect(JSON.parse(listed.output).currentComputerId).toBe("remote-mac")
    }),
  ))

  it.instance("accepts an unambiguous platform or exact computer name", () => withEnv(() =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create()
      const tool = yield* Tool.init(yield* SwitchComputerTool)
      expect((yield* tool.execute({ computerId: "macOS" }, context(session.id))).metadata.computerId).toBe("remote-mac")
      expect((yield* tool.execute({ computerId: "linux tower" }, context(session.id))).metadata.computerId).toBe("local")
    }),
  ))

  it.instance("refuses offline, missing and ambiguous targets without changing selection", () => withEnv(() =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create()
      const tool = yield* Tool.init(yield* SwitchComputerTool)
      yield* tool.execute({ computerId: "remote-mac" }, context(session.id))
      expect(yield* failure(tool.execute({ computerId: "remote-offline" }, context(session.id)))).toContain("offline")
      expect(yield* failure(tool.execute({ computerId: "missing" }, context(session.id)))).toContain("No paired computer")
      computers = [...devices, { id: "second-mac", name: "Mac mini", platform: "darwin", connected: true }]
      expect(yield* failure(tool.execute({ computerId: "macOS" }, context(session.id)))).toContain("several computers")
      expect(selectionFromMetadata((yield* sessions.get(session.id)).metadata, yield* configFromEnv())).toBe("remote-mac")
    }),
  ))

  it.instance("a denied or cancelled switch leaves metadata untouched", () => withEnv(() =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ metadata: { mode: "work" } })
      const tool = yield* Tool.init(yield* SwitchComputerTool)
      const denied = context(session.id, () => Effect.die(new Error("Permission denied")))
      expect(yield* failure(tool.execute({ computerId: "remote-mac" }, denied))).toContain("Permission denied")
      const controller = new AbortController()
      controller.abort()
      expect(yield* failure(tool.execute({ computerId: "remote-mac" }, { ...context(session.id), abort: controller.signal }))).toContain("cancelled")
      expect((yield* sessions.get(session.id)).metadata).toEqual({ mode: "work" })
    }),
  ))

  it.instance("never silently falls back if a selected device disconnects or the server changes", () => withEnv(() =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create()
      const tool = yield* Tool.init(yield* SwitchComputerTool)
      yield* tool.execute({ computerId: "remote-mac" }, context(session.id))
      computers = devices.map((computer) => computer.id === "remote-mac" ? { ...computer, connected: false } : computer)
      const config = yield* configFromEnv()
      expect(yield* computerId(http, config, session.id)).toBe("remote-mac")
      expect(yield* failure(computerId(http, { ...config, url: "http://different.example" }, session.id))).toContain("different control plane")
    }),
  ))
})
