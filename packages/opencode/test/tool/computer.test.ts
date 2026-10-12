import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { Headers, HttpClient, HttpClientResponse } from "effect/unstable/http"
import type { HttpClientRequest } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { configFromEnv, rememberObservation, request } from "@/tool/computer/client"
import { ComputerActTool, Parameters as ActParameters } from "@/tool/computer/act"
import { ComputerAppsTool } from "@/tool/computer/apps"
import { ComputerCapabilitiesTool } from "@/tool/computer/capabilities"
import { ComputerContextTool } from "@/tool/computer/context"
import { ComputerDoTool, Parameters as DoParameters } from "@/tool/computer/do"
import { ComputerFindTool, Parameters as FindParameters } from "@/tool/computer/find"
import { ComputerInspectTool, Parameters as InspectParameters } from "@/tool/computer/inspect"
import { MemoryTool, Parameters as MemoryParameters } from "@/tool/computer/memory"
import { ComputerObserveTool, Parameters as ObserveParameters } from "@/tool/computer/observe"
import { ComputerSnapshotTool, Parameters as SnapshotParameters } from "@/tool/computer/snapshot"
import { ComputerReadTool, Parameters as ReadParameters } from "@/tool/computer/read"
import { ComputerScreenshotTool, Parameters as ScreenshotParameters } from "@/tool/computer/screenshot"
import { SuperskillTool, Parameters as SuperskillParameters } from "@/tool/computer/superskill"
import { invalidateObservations, recordObservation } from "@/tool/computer/switch"
import { ComputerVisualTool, Parameters as VisualParameters } from "@/tool/computer/visual"
import {
  alwaysPatternsForAct,
  alwaysPatternsForSteps,
  applicationOf,
  batchScopes,
  isHttpUrl,
  permissionText,
  scopesForAct,
  scopesForAction,
  shortenCommand,
  validateAction,
} from "@/tool/computer/policy"
import { CAPS, clip } from "@/tool/computer/output"

const decodeObserve = Schema.decodeUnknownSync(ObserveParameters)
const decodeSnapshot = Schema.decodeUnknownSync(SnapshotParameters)
const decodeFind = Schema.decodeUnknownSync(FindParameters)
const decodeAct = Schema.decodeUnknownSync(ActParameters)
const decodeDo = Schema.decodeUnknownSync(DoParameters)
const decodeRead = Schema.decodeUnknownSync(ReadParameters)
const decodeScreenshot = Schema.decodeUnknownSync(ScreenshotParameters)
const decodeSuperskill = Schema.decodeUnknownSync(SuperskillParameters)

type AskCapture = {
  patterns: readonly string[]
  always: readonly string[]
  metadata?: Record<string, unknown>
}

type MockRequest = HttpClientRequest.HttpClientRequest

interface MockState {
  handler: (req: MockRequest) => Effect.Effect<HttpClientResponse.HttpClientResponse>
  asked: AskCapture[]
  bodies: Record<string, unknown>[]
  urls: string[]
  proofs: Array<string | undefined>
}

const mock: MockState = {
  handler: () => Effect.die(new Error("unhandled mock request")),
  asked: [],
  bodies: [],
  urls: [],
  proofs: [],
}

const mockClient = HttpClient.make((req) => {
  mock.urls.push(req.url)
  mock.proofs.push(Option.getOrUndefined(Headers.get(req.headers, "x-omnia-session-proof")))
  const body = bodyJson(req)
  if (body !== undefined) mock.bodies.push(body)
  return mock.handler(req)
})

const testLayer = LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node]), [
  [httpClient, Layer.succeed(HttpClient.HttpClient, mockClient)],
])

const it = testEffect(testLayer)

function resetMock() {
  mock.asked = []
  mock.bodies = []
  mock.urls = []
  mock.proofs = []
}

function respond(req: MockRequest, body: unknown, status = 200) {
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      req,
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  )
}

function bodyJson(req: MockRequest): Record<string, unknown> | undefined {
  const parsed = req.body.toJSON()
  if (typeof parsed !== "object" || parsed === null) return undefined
  const body = (parsed as { body?: unknown }).body
  if (typeof body !== "string") return undefined
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(body)
  if (Option.isNone(decoded) || typeof decoded.value !== "object" || decoded.value === null) return undefined
  return decoded.value as Record<string, unknown>
}

function withEnv<A, E, R>(
  options: { computerId?: string; url?: string },
  fn: () => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = {
        url: process.env.OMNIA_SERVER_URL,
        token: process.env.OMNIA_SERVER_TOKEN,
        computer: process.env.OMNIA_COMPUTER_ID,
      }
      process.env.OMNIA_SERVER_URL = options.url ?? "http://127.0.0.1:9"
      process.env.OMNIA_SERVER_TOKEN = "test-token"
      if (options.computerId === undefined) delete process.env.OMNIA_COMPUTER_ID
      else process.env.OMNIA_COMPUTER_ID = options.computerId
      return previous
    }),
    fn,
    (previous) =>
      Effect.sync(() => {
        if (previous.url === undefined) delete process.env.OMNIA_SERVER_URL
        else process.env.OMNIA_SERVER_URL = previous.url
        if (previous.token === undefined) delete process.env.OMNIA_SERVER_TOKEN
        else process.env.OMNIA_SERVER_TOKEN = previous.token
        if (previous.computer === undefined) delete process.env.OMNIA_COMPUTER_ID
        else process.env.OMNIA_COMPUTER_ID = previous.computer
      }),
  )
}

function makeCtx(asked: AskCapture[]): Tool.Context {
  return {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    callID: "",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata() {
      return Effect.void
    },
    ask(input) {
      asked.push(input)
      return Effect.void
    },
  }
}

const execAct = Effect.fn("test.execAct")(function* (args: Schema.Schema.Type<typeof ActParameters>) {
  const info = yield* ComputerActTool
  const tool = yield* info.init()
  return yield* tool.execute(args, makeCtx(mock.asked))
})

const execDo = Effect.fn("test.execDo")(function* (args: Schema.Schema.Type<typeof DoParameters>) {
  const info = yield* ComputerDoTool
  const tool = yield* info.init()
  return yield* tool.execute(args, makeCtx(mock.asked))
})

const execRead = Effect.fn("test.execRead")(function* (args: Schema.Schema.Type<typeof ReadParameters>) {
  const info = yield* ComputerReadTool
  const tool = yield* info.init()
  return yield* tool.execute(args, makeCtx(mock.asked))
})

const execSuperskill = Effect.fn("test.execSuperskill")(function* (
  args: Schema.Schema.Type<typeof SuperskillParameters>,
) {
  const info = yield* SuperskillTool
  const tool = yield* info.init()
  return yield* tool.execute(args, makeCtx(mock.asked))
})

const execVisual = Effect.fn("test.execVisual")(function* (args: Schema.Schema.Type<typeof VisualParameters>) {
  const info = yield* ComputerVisualTool
  const tool = yield* info.init()
  return yield* tool.execute(args, makeCtx(mock.asked))
})

const execContext = Effect.fn("test.execContext")(function* () {
  const info = yield* ComputerContextTool
  const tool = yield* info.init()
  return yield* tool.execute({}, makeCtx(mock.asked))
})

const execFind = Effect.fn("test.execFind")(function* (args: Schema.Schema.Type<typeof FindParameters>) {
  const info = yield* ComputerFindTool
  const tool = yield* info.init()
  return yield* tool.execute(args, makeCtx(mock.asked))
})

const execInspect = Effect.fn("test.execInspect")(function* (args: Schema.Schema.Type<typeof InspectParameters>) {
  const info = yield* ComputerInspectTool
  const tool = yield* info.init()
  return yield* tool.execute(args, makeCtx(mock.asked))
})

const execObserve = Effect.fn("test.execObserve")(function* (args: Schema.Schema.Type<typeof ObserveParameters>) {
  const info = yield* ComputerObserveTool
  const tool = yield* info.init()
  return yield* tool.execute(args, makeCtx(mock.asked))
})

const execSnapshot = Effect.fn("test.execSnapshot")(function* (args: Schema.Schema.Type<typeof SnapshotParameters>) {
  const info = yield* ComputerSnapshotTool
  const tool = yield* info.init()
  return yield* tool.execute(args, makeCtx(mock.asked))
})

const execApps = Effect.fn("test.execApps")(function* () {
  const info = yield* ComputerAppsTool
  const tool = yield* info.init()
  return yield* tool.execute({}, makeCtx(mock.asked))
})

const execCapabilities = Effect.fn("test.execCapabilities")(function* () {
  const info = yield* ComputerCapabilitiesTool
  const tool = yield* info.init()
  return yield* tool.execute({}, makeCtx(mock.asked))
})

const execMemory = Effect.fn("test.execMemory")(function* (args: Schema.Schema.Type<typeof MemoryParameters>) {
  const info = yield* MemoryTool
  const tool = yield* info.init()
  return yield* tool.execute(args, makeCtx(mock.asked))
})

const execScreenshot = Effect.fn("test.execScreenshot")(function* (
  args: Schema.Schema.Type<typeof ScreenshotParameters>,
) {
  const info = yield* ComputerScreenshotTool
  const tool = yield* info.init()
  return yield* tool.execute(args, makeCtx(mock.asked))
})

describe("computer server config", () => {
  test("refuses to run without an Omnia Server", () => {
    const url = process.env.OMNIA_SERVER_URL
    const token = process.env.OMNIA_SERVER_TOKEN
    const computer = process.env.OMNIA_COMPUTER_ID
    delete process.env.OMNIA_SERVER_URL
    delete process.env.OMNIA_SERVER_TOKEN
    delete process.env.OMNIA_COMPUTER_ID
    try {
      expect(() => Effect.runSync(configFromEnv())).toThrow("Omnia Server is not running")
    } finally {
      if (url !== undefined) process.env.OMNIA_SERVER_URL = url
      if (token !== undefined) process.env.OMNIA_SERVER_TOKEN = token
      if (computer !== undefined) process.env.OMNIA_COMPUTER_ID = computer
    }
  })

  test("reads server coordinates from the environment", () => {
    process.env.OMNIA_SERVER_URL = "http://127.0.0.1:1"
    process.env.OMNIA_SERVER_TOKEN = "token"
    process.env.OMNIA_COMPUTER_ID = "linux-host"
    try {
      expect(Effect.runSync(configFromEnv())).toEqual({
        url: "http://127.0.0.1:1",
        token: "token",
        computerId: "linux-host",
      })
    } finally {
      delete process.env.OMNIA_SERVER_URL
      delete process.env.OMNIA_SERVER_TOKEN
      delete process.env.OMNIA_COMPUTER_ID
    }
  })

  test("normalizes trailing slashes and rejects non-http urls", () => {
    process.env.OMNIA_SERVER_URL = "http://127.0.0.1:1///"
    process.env.OMNIA_SERVER_TOKEN = "token"
    try {
      expect(Effect.runSync(configFromEnv()).url).toBe("http://127.0.0.1:1")
      process.env.OMNIA_SERVER_URL = "file:///tmp/socket"
      expect(() => Effect.runSync(configFromEnv())).toThrow("http:// or https://")
    } finally {
      delete process.env.OMNIA_SERVER_URL
      delete process.env.OMNIA_SERVER_TOKEN
      delete process.env.OMNIA_COMPUTER_ID
    }
  })
})

describe("computer tool schemas", () => {
  test("observe accepts empty params", () => {
    expect(decodeObserve({})).toEqual({})
  })

  test("observe bounds the control limit", () => {
    expect(decodeObserve({ limit: 5 })).toEqual({ limit: 5 })
    expect(() => decodeObserve({ limit: 0 })).toThrow()
    expect(() => decodeObserve({ limit: 1001 })).toThrow()
  })

  test("observe accepts focusFirst as a boolean", () => {
    expect(decodeObserve({ focusFirst: false })).toEqual({ focusFirst: false })
    expect(() => decodeObserve({ focusFirst: "false" })).toThrow()
  })

  test("snapshot accepts empty params and pages elements", () => {
    expect(decodeSnapshot({})).toEqual({})
    expect(decodeSnapshot({ app: "soffice", limit: 10, offset: 5 })).toEqual({ app: "soffice", limit: 10, offset: 5 })
    expect(() => decodeSnapshot({ limit: 0 })).toThrow()
    expect(() => decodeSnapshot({ limit: 1001 })).toThrow()
    expect(() => decodeSnapshot({ offset: -1 })).toThrow()
  })

  test("find requires a query", () => {
    expect(() => decodeFind({})).toThrow()
    expect(decodeFind({ query: "Export" })).toEqual({ query: "Export" })
  })

  test("find drops the unsupported applicationId parameter", () => {
    expect(decodeFind({ query: "Export", applicationId: "soffice" })).toEqual({ query: "Export" })
  })

  test("find accepts a window filter", () => {
    expect(decodeFind({ query: "Export", window: "Writer" })).toEqual({ query: "Export", window: "Writer" })
  })

  test("screenshot validates the optional capture region", () => {
    expect(decodeScreenshot({})).toEqual({})
    expect(decodeScreenshot({ region: { x: 10, y: 20, width: 100, height: 50 } })).toEqual({
      region: { x: 10, y: 20, width: 100, height: 50 },
    })
    expect(() => decodeScreenshot({ region: { x: -1, y: 0, width: 10, height: 10 } })).toThrow()
    expect(() => decodeScreenshot({ region: { x: 0, y: 0, width: 0, height: 10 } })).toThrow()
  })

  test("act accepts a target or a semantic query", () => {
    expect(decodeAct({ action: "click", target: "atspi:3.5" })).toEqual({
      action: "click",
      target: "atspi:3.5",
    })
    expect(decodeAct({ action: "click", query: "Export button" })).toEqual({
      action: "click",
      query: "Export button",
    })
    expect(decodeAct({ action: "read_text", query: "document text" })).toEqual({
      action: "read_text",
      query: "document text",
    })
    expect(decodeAct({ action: "write_clipboard", text: "hello" })).toEqual({
      action: "write_clipboard",
      text: "hello",
    })
    expect(decodeAct({ action: "read_value" })).toEqual({ action: "read_value" })
    expect(decodeAct({ action: "run_command", command: "sudo systemctl restart nginx", credential: "auto" })).toEqual({
      action: "run_command",
      command: "sudo systemctl restart nginx",
      credential: "auto",
    })
    expect(decodeAct({ action: "credentials" })).toEqual({ action: "credentials" })
    expect(decodeAct({ action: "type", target: "atspi:9.1", credential: "auto" })).toEqual({
      action: "type",
      target: "atspi:9.1",
      credential: "auto",
    })
    expect(decodeAct({ action: "type", target: "atspi:9.1", credential: "login", field: "username" })).toEqual({
      action: "type",
      target: "atspi:9.1",
      credential: "login",
      field: "username",
    })
    expect(() => decodeAct({ action: "type", target: "atspi:9.1", field: "token" })).toThrow()
    expect(() => decodeAct({ action: "not_a_real_action" })).toThrow()
  })

  test("act bounds numeric parameters", () => {
    expect(() => decodeAct({ action: "run_command", command: "ls", timeoutMs: 700000 })).toThrow()
    expect(() => decodeAct({ action: "scroll", direction: "down", amount: -1 })).toThrow()
    expect(() => decodeAct({ action: "click", target: "a", x: 1.5, y: 2 })).toThrow()
    expect(decodeAct({ action: "run_command", command: "ls", timeoutMs: 1000 })).toEqual({
      action: "run_command",
      command: "ls",
      timeoutMs: 1000,
    })
  })

  test("do accepts the full shared action union", () => {
    expect(decodeDo({ steps: [{ action: "set_value", target: "atspi:1", text: "x" }] })).toEqual({
      steps: [{ action: "set_value", target: "atspi:1", text: "x" }],
    })
    expect(decodeDo({ steps: [{ action: "window_tile", position: "left" }] })).toEqual({
      steps: [{ action: "window_tile", position: "left" }],
    })
    expect(() => decodeDo({ steps: [{ action: "browser_click", tab: "t1" }] })).not.toThrow()
    expect(
      decodeDo({
        steps: [{ action: "browser_dialog", dialog: "accept", promptText: "Ada", expectedType: "prompt" }],
      }),
    ).toEqual({
      steps: [{ action: "browser_dialog", dialog: "accept", promptText: "Ada", expectedType: "prompt" }],
    })
  })

  test("do allowUnverified defaults to absent and accepts true", () => {
    expect(decodeDo({ steps: [{ action: "click", query: "A" }] })).toEqual({
      steps: [{ action: "click", query: "A" }],
    })
    expect(decodeDo({ steps: [{ action: "click", query: "A", allowUnverified: true }] })).toEqual({
      steps: [{ action: "click", query: "A", allowUnverified: true }],
    })
  })

  test("read accepts offset and bounds the limit", () => {
    expect(decodeRead({ target: "atspi:1", offset: 10, limit: 100 })).toEqual({
      target: "atspi:1",
      offset: 10,
      limit: 100,
    })
    expect(() => decodeRead({ target: "atspi:1", offset: -1 })).toThrow()
  })
})

describe("computer action policy", () => {
  test("validates each action before running", () => {
    expect(() => validateAction({ action: "scroll" })).toThrow("requires direction")
    expect(() => validateAction({ action: "drag", from: { elementId: "a" } })).toThrow("from and to")
    expect(() => validateAction({ action: "paste_table", rows: [] })).toThrow("requires rows")
    expect(() => validateAction({ action: "window_tile", position: "middle" })).toThrow("position must be one of")
    expect(() => validateAction({ action: "window_move", x: 1 })).toThrow("requires x and y")
    expect(() => validateAction({ action: "calibration_measure" })).toThrow("requires point")
    expect(() => validateAction({ action: "menu" })).toThrow("requires query")
    expect(() => validateAction({ action: "write_clipboard" })).toThrow("requires text")
    expect(() => validateAction({ action: "open_url", url: "javascript:alert(1)" })).toThrow("http://")
    expect(() => validateAction({ action: "open_url", url: "file:///etc/passwd" })).toThrow("http://")
    expect(() => validateAction({ action: "open_url", url: "https://example.com" })).not.toThrow()
    expect(() => validateAction({ action: "browser_key" })).toThrow("requires key")
    expect(() => validateAction({ action: "browser_activate_tab" })).toThrow("requires tab")
    expect(() => validateAction({ action: "browser_dialog" })).toThrow('dialog "accept" or "dismiss"')
    expect(() => validateAction({ action: "browser_dialog", dialog: "later" })).toThrow('dialog "accept" or "dismiss"')
    expect(() => validateAction({ action: "browser_dialog", dialog: "dismiss" })).not.toThrow()
    expect(() => validateAction({ action: "type", target: "a" })).toThrow("requires text")
    expect(() => validateAction({ action: "type", target: "a", credential: "auto" })).not.toThrow()
    expect(() => validateAction({ action: "type", text: "hi" })).toThrow("requires target, query, or window")
    expect(() => validateAction({ action: "type", window: "Editor", text: "hi" })).not.toThrow()
    expect(() => validateAction({ action: "click", x: 4 })).toThrow("target, query, or x/y")
    expect(() => validateAction({ action: "click", x: 4, y: 5 })).not.toThrow()
    expect(() => validateAction({ action: "drag", from: { x: 1, y: 2 }, to: { x: 3, y: 4 } })).not.toThrow()
    expect(() => validateAction({ action: "browser_scroll" })).toThrow("deltaX or deltaY")
    expect(() => validateAction({ action: "browser_scroll", deltaY: 800 })).not.toThrow()
  })

  test("scopes each action to its capability class", () => {
    expect(scopesForAction("observe")).toEqual(["UI_READ"])
    expect(scopesForAction("click")).toEqual(["UI_CONTROL"])
    expect(scopesForAction("type")).toEqual(["UI_CONTROL", "KEYBOARD"])
    expect(scopesForAction("scroll")).toEqual(["POINTER"])
    expect(scopesForAction("run_command")).toEqual(["PROCESS_EXECUTE"])
    expect(scopesForAction("credentials")).toEqual(["SECRETS"])
    expect(scopesForAction("browser_navigate")).toEqual(["BROWSER"])
    expect(scopesForAction("browser_dialog")).toEqual(["BROWSER"])
    expect(scopesForAction("screenshot")).toEqual(["SCREEN_READ"])
    expect(scopesForAct({ action: "run_command", command: "sudo x" })).toEqual(["PROCESS_EXECUTE"])
    expect(scopesForAct({ action: "run_command", command: "sudo x", credential: "auto" })).toEqual([
      "PROCESS_EXECUTE",
      "SECRETS",
    ])
    expect(scopesForAct({ action: "type", credential: "auto" })).toEqual(["UI_CONTROL", "KEYBOARD", "SECRETS"])
    expect(scopesForAct({ action: "browser_type", credential: "login" })).toEqual(["BROWSER", "SECRETS"])
  })

  test("matches the server scope map for window_close, paste_table, and scroll_into_view", () => {
    expect(scopesForAction("window_close")).toEqual(["PROCESS_EXECUTE"])
    expect(scopesForAction("paste_table")).toEqual(["CLIPBOARD_WRITE", "KEYBOARD", "POINTER"])
    expect(scopesForAction("scroll_into_view")).toEqual(["POINTER"])
  })

  test("batch scopes cover browser, secrets, and file expectations", () => {
    const scopes = batchScopes([
      { action: "browser_click", query: "Search" },
      { action: "run_command", command: "ls", credential: "auto" },
      { action: "click", query: "Save", expect: { file: "/tmp/out" } },
    ])
    expect(scopes).toContain("BROWSER")
    expect(scopes).toContain("SECRETS")
    expect(scopes).toContain("FILES_READ")
    expect(scopes).toContain("PROCESS_EXECUTE")
    expect(scopes).toContain("UI_CONTROL")
    expect(scopes).not.toContain("NETWORK")
  })

  test("always patterns never span capability classes", () => {
    expect(alwaysPatternsForAct("click")).toEqual(["act:click:*"])
    expect(alwaysPatternsForAct("run_command")).toEqual(["act:run_command:*"])
    expect(alwaysPatternsForSteps([{ action: "click" }, { action: "run_command", command: "ls" }])).toEqual([
      "do:click:*",
      "do:run_command:*",
    ])
  })

  test("redacts typed text and shortens commands in permission metadata", () => {
    expect(permissionText("type", "hunter2")).toBe("[redacted 7 characters]")
    expect(permissionText("set_value", "secret")).toBe("[redacted 6 characters]")
    expect(permissionText("click", "not a secret")).toBe("not a secret")
    expect(shortenCommand("sudo systemctl restart nginx")).toBe("sudo")
    expect(shortenCommand("ls")).toBe("ls")
    expect(isHttpUrl("https://example.com")).toBe(true)
    expect(isHttpUrl("data:text/html,x")).toBe(false)
  })

  test("resolves the app alias for read and observe", () => {
    expect(applicationOf({ app: " soffice " })).toBe("soffice")
    expect(applicationOf({ applicationId: "calc" })).toBe("calc")
    expect(applicationOf({ app: "soffice", applicationId: "calc" })).toBe("soffice")
    expect(applicationOf({})).toBeUndefined()
  })

  test("clip marks truncated output", () => {
    expect(clip("hello", 10)).toBe("hello")
    const clipped = clip("a".repeat(20), 5)
    expect(clipped.startsWith("aaaaa")).toBe(true)
    expect(clipped).toContain("truncated")
    expect(clipped).toContain("15 of 20")
  })
})

// computer_act reads the current observation before it acts, so an act mock
// must answer the observe request as well as the action request.
const ACT_ELEMENTS = [
  { id: "cua:window/kitty/Editor", role: "window", name: "Editor", bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  {
    id: "cua:window/kitty/Editor/3/button/Minimize/1",
    role: "button",
    name: "Minimize",
    bounds: { x: 1800, y: 36, width: 24, height: 24 },
    actions: ["click"],
  },
  {
    id: "el-save",
    role: "button",
    name: "Save",
    bounds: { x: 200, y: 100, width: 60, height: 24 },
    actions: ["click"],
  },
  {
    id: "el-export",
    role: "button",
    name: "Export",
    bounds: { x: 270, y: 100, width: 60, height: 24 },
    actions: ["click"],
  },
  {
    id: "atspi:1",
    role: "textfield",
    name: "Command",
    bounds: { x: 10, y: 40, width: 800, height: 24 },
    actions: ["set_value"],
  },
]

function actResponder(options: { elements?: unknown[]; observationId?: string; result?: unknown }) {
  return (req: MockRequest) =>
    req.url.endsWith("/observe")
      ? respond(req, {
          ok: true,
          observation: { id: options.observationId ?? "obs-1", elements: options.elements ?? ACT_ELEMENTS },
        })
      : respond(req, { ok: true, result: options.result ?? { success: true, verification: { status: "verified" } } })
}

/** The request bodies sent to /actions, without the observation read. */
function actionBodies(): Record<string, unknown>[] {
  return mock.bodies.filter((body) => body.action !== undefined)
}

describe("computer tool execution", () => {
  it.instance("scopes act permission always-patterns and redacts typed text", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = actResponder({})
      yield* withEnv({ computerId: "test-computer" }, () =>
        execAct({ action: "type", target: "atspi:1", text: "hunter2" }),
      )
      expect(mock.asked).toHaveLength(1)
      expect(mock.asked[0].always).toEqual(["act:type:*"])
      expect(mock.asked[0].patterns).toEqual(["act:type:atspi:1"])
      expect(mock.asked[0].metadata?.text).toBe("[redacted 7 characters]")
      expect(actionBodies()[0].approvedScopes).toEqual(["UI_CONTROL", "KEYBOARD"])
    }),
  )

  it.instance("scopes run_command patterns and requests SECRETS only when a credential is used", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) => respond(req, { ok: true, result: { success: true } })
      yield* withEnv({ computerId: "test-computer" }, () =>
        execAct({ action: "run_command", command: "sudo systemctl restart nginx", credential: "auto" }),
      )
      expect(mock.asked[0].always).toEqual(["act:run_command:*"])
      expect(mock.asked[0].patterns[0]).toBe("act:run_command:sudo")
      expect(mock.asked[0].metadata?.command).toBe("sudo")
      expect(mock.bodies[0].approvedScopes).toEqual(["PROCESS_EXECUTE", "SECRETS"])
    }),
  )

  it.instance("attaches observationId to query targets at the top level", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = actResponder({})
      yield* withEnv({ computerId: "test-computer" }, () =>
        execAct({ action: "click", query: "Export", observationId: "obs-7" }),
      )
      expect(actionBodies()[0].observationId).toBe("obs-7")
      expect(actionBodies()[0].target).toBeUndefined()
    }),
  )

  it.instance("refuses a ref that is not in the observation it claims", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = actResponder({
        observationId: "obs-9",
        elements: [
          { id: "cua:window/kitty/Editor", role: "window", name: "Editor" },
          { id: "el-save", role: "button", name: "Save", bounds: { x: 200, y: 100, width: 60, height: 24 } },
        ],
      })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execAct({ action: "click", target: "cua:window/kitty/Editor/3/button/Minimize/1", observationId: "obs-1" }),
      )
      expect((result.metadata as { success?: boolean }).success).toBe(false)
      expect((result.metadata as { refused?: boolean }).refused).toBe(true)
      expect((result.metadata as { error?: { code?: string } }).error?.code).toBe("target_stale")
      expect(result.output).toContain("obs-1")
      expect(result.output).toContain("computer_snapshot")
      expect(mock.urls.some((url) => url.endsWith("/actions"))).toBe(false)
      expect(mock.asked).toHaveLength(0)
    }),
  )

  it.instance("resolves a ref against the newest observation when no observationId is given", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = actResponder({ observationId: "obs-12" })
      yield* withEnv({ computerId: "test-computer" }, () =>
        execAct({ action: "click", target: "cua:window/kitty/Editor/3/button/Minimize/1" }),
      )
      expect(mock.asked).toHaveLength(1)
      expect(actionBodies()[0].target).toEqual({
        elementId: "cua:window/kitty/Editor/3/button/Minimize/1",
      })
    }),
  )

  it.instance("fails a ref when no observation can be read", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        req.url.endsWith("/observe")
          ? respond(req, { ok: true, result: { success: true } })
          : respond(req, { ok: false })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execAct({ action: "click", target: "cua:window/kitty/Editor/3/button/Minimize/1" }),
      )
      expect((result.metadata as { refused?: boolean }).refused).toBe(true)
      expect((result.metadata as { error?: { code?: string } }).error?.code).toBe("observation_unavailable")
      expect(result.output).toContain("computer_snapshot")
      expect(mock.urls.some((url) => url.endsWith("/actions"))).toBe(false)
    }),
  )

  it.instance("refuses a low-confidence query instead of clicking a guess", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = actResponder({ observationId: "obs-3" })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execAct({ action: "click", query: "window", observationId: "obs-3" }),
      )
      expect((result.metadata as { refused?: boolean }).refused).toBe(true)
      expect((result.metadata as { error?: { code?: string } }).error?.code).toBe("target_not_found")
      expect(result.output).toContain('searched "window"')
      expect(result.output).toContain("obs-3")
      expect(result.output).toContain("0.6 floor")
      expect(mock.urls.some((url) => url.endsWith("/actions"))).toBe(false)
    }),
  )

  it.instance("refuses raw pixels unless the surface is a canvas or coordinates are allowed", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = actResponder({ observationId: "obs-4" })
      const refused = yield* withEnv({ computerId: "test-computer" }, () =>
        execAct({ action: "click", x: 500, y: 500 }),
      )
      expect((refused.metadata as { refused?: boolean }).refused).toBe(true)
      expect((refused.metadata as { error?: { code?: string } }).error?.code).toBe("coordinates_required")
      expect(refused.output).toContain('surface: "canvas"')
      expect(mock.urls.some((url) => url.endsWith("/actions"))).toBe(false)

      resetMock()
      mock.handler = actResponder({ observationId: "obs-4" })
      const onControl = yield* withEnv({ computerId: "test-computer" }, () =>
        execAct({ action: "click", x: 210, y: 112, allowCoordinates: true }),
      )
      expect((onControl.metadata as { error?: { code?: string } }).error?.code).toBe("coordinate_on_control")
      expect(onControl.output).toContain("ref=el-save")
      expect(mock.urls.some((url) => url.endsWith("/actions"))).toBe(false)

      resetMock()
      mock.handler = actResponder({ observationId: "obs-4" })
      const canvas = yield* withEnv({ computerId: "test-computer" }, () =>
        execAct({ action: "click", x: 500, y: 500, surface: "canvas" }),
      )
      expect((canvas.metadata as { refused?: boolean }).refused).toBeUndefined()
      expect(actionBodies()[0]).toMatchObject({ x: 500, y: 500 })

      resetMock()
      mock.handler = actResponder({ observationId: "obs-4" })
      const declared = yield* withEnv({ computerId: "test-computer" }, () =>
        execAct({ action: "click", x: 500, y: 500, surface: true }),
      )
      expect((declared.metadata as { refused?: boolean }).refused).toBeUndefined()
      expect(actionBodies()[0]).toMatchObject({ x: 500, y: 500 })

      resetMock()
      mock.handler = actResponder({ observationId: "obs-4" })
      const empty = yield* withEnv({ computerId: "test-computer" }, () =>
        execAct({ action: "click", x: 500, y: 500, allowCoordinates: true }),
      )
      expect((empty.metadata as { refused?: boolean }).refused).toBeUndefined()
      expect(actionBodies()[0]).toMatchObject({ x: 500, y: 500 })
    }),
  )

  it.instance("reports the aim point it resolved for the target", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = actResponder({ observationId: "obs-5" })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execAct({ action: "click", target: "el-save", observationId: "obs-5" }),
      )
      expect(result.metadata).toMatchObject({ aim: { x: 230, y: 112, strategy: "control-center" } })
      expect(result.output).toContain("aim: 230,112 (control-center)")
      expect(result.output).toContain('resolved: button "Save" ref=el-save')

      resetMock()
      mock.handler = actResponder({ observationId: "obs-5" })
      const queried = yield* withEnv({ computerId: "test-computer" }, () =>
        execAct({ action: "click", query: "Save", observationId: "obs-5" }),
      )
      expect(queried.metadata).toMatchObject({ aim: { x: 230, y: 112, strategy: "control-center" } })
      expect(queried.output).toContain("aim: 230,112 (control-center)")
    }),
  )

  it.instance("renders clipboard text alongside the character count", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          result: {
            success: true,
            message: "Read 14 clipboard characters.",
            text: "hello, world!!",
            length: 14,
            hash: "hash-clip",
            metadata: { preview: "hello, world!!", length: 14, hash: "hash-clip" },
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execAct({ action: "read_clipboard" }))
      expect(result.output).toContain("Read 14 clipboard characters.")
      expect(result.output).toContain("clipboard:")
      expect(result.output).toContain("hello, world!!")
      expect(result.output).toContain("[length=14 hash=hash-clip]")
    }),
  )

  it.instance("clips oversized clipboard text through the shared limit", () =>
    Effect.gen(function* () {
      resetMock()
      const long = "a".repeat(CAPS.actText + 25)
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          result: { success: true, message: `Read ${long.length} clipboard characters.`, metadata: { preview: long } },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execAct({ action: "read_clipboard" }))
      expect(result.output).toContain("truncated")
      expect(result.output).not.toContain(long)
    }),
  )

  it.instance("includes BROWSER and per-step scopes in a do batch", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, { ok: true, result: { success: true, completed: 2, total: 2, steps: [], message: "done" } })
      yield* withEnv({ computerId: "test-computer" }, () =>
        execDo({
          steps: [
            { action: "browser_click", query: "Search", tab: "t1" },
            { action: "run_command", command: "ls", credential: "auto", expect: { file: "/tmp/out" } },
          ],
        }),
      )
      const scopes = mock.bodies[0].approvedScopes as string[]
      expect(scopes).toContain("BROWSER")
      expect(scopes).toContain("SECRETS")
      expect(scopes).toContain("FILES_READ")
      expect(scopes).toContain("PROCESS_EXECUTE")
      expect(mock.asked[0].always).toContain("do:browser_click:*")
      expect(mock.asked[0].always).toContain("do:run_command:*")
      expect(mock.asked[0].always).not.toContain("*")
    }),
  )

  it.instance("binds all ref steps to one cached observation and reports aim", () =>
    Effect.gen(function* () {
      resetMock()
      const observationId = `obs-do-${crypto.randomUUID()}`
      const ref = `cua:button/save@g${Date.now()}`
      const observation = rememberObservation("test-computer", "*\n*", observationId, [], [
        { id: ref, role: "button", name: "Save", actions: ["click"], bounds: { x: 10, y: 20, width: 80, height: 24 } },
      ])
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          result: {
            success: true,
            completed: 1,
            total: 1,
            message: "Completed 1 of 1 step(s).",
            steps: [{
              index: 0,
              action: "click",
              success: true,
              verified: true,
              verification: { status: "verified", method: "state-delta" },
              aim: { x: 50, y: 32, strategy: "bounds-center" },
              warnings: ["aim strategy bounds-center is a guess"],
              message: "Clicked Save.",
            }],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execDo({
          observationId,
          steps: [{ action: "click", target: ref }],
        }),
      )
      const body = mock.bodies[0]!
      const step = (body.steps as Array<Record<string, unknown>>)[0]!
      expect(body.observationId).toBe(observationId)
      expect(body.resumeFrom).toBeUndefined()
      expect((step.target as Record<string, unknown>).observationId).toBe(observationId)
      expect((step.target as Record<string, unknown>).generation).toBe(observation.generation)
      expect(result.output).toContain("aim: 50,32 (bounds-center)")
      expect(result.output).toContain("aim strategy bounds-center is a guess")
      expect(result.metadata.success).toBe(true)
    }),
  )

  it.instance("refuses mixed-observation plans before permission or request", () =>
    Effect.gen(function* () {
      resetMock()
      const exit = yield* Effect.exit(withEnv({ computerId: "test-computer" }, () =>
        execDo({
          steps: [
            { action: "click", target: "ref-one", observationId: "obs-one" },
            { action: "click", target: "ref-two", observationId: "obs-two" },
          ],
        }),
      ))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("one observationId")
      expect(mock.asked).toHaveLength(0)
      expect(mock.bodies).toHaveLength(0)
    }),
  )

  it.instance("refuses a plan whose target is absent from its cached observation", () =>
    Effect.gen(function* () {
      resetMock()
      const observationId = `obs-do-missing-${crypto.randomUUID()}`
      rememberObservation("test-computer", "*\n*", observationId, [], [{ id: "cua:button/other@g1", role: "button" }])
      const exit = yield* Effect.exit(withEnv({ computerId: "test-computer" }, () =>
        execDo({ observationId, steps: [{ action: "click", target: "cua:button/save@g1" }] }),
      ))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("not in observation")
      expect(mock.asked).toHaveLength(0)
      expect(mock.bodies).toHaveLength(0)
    }),
  )

  it.instance("renders the server-provided absolute step indexes without re-adding resumeFrom", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: false,
          result: {
            success: false,
            completed: 1,
            total: 4,
            failedAt: 3,
            message: "Step 4 failed",
            steps: [
              { index: 2, action: "click", success: true, verification: { status: "unverified" } },
              {
                index: 3,
                action: "run_command",
                success: false,
                error: { code: "command_failed", message: "boom", details: { exitCode: 1, stderr: "nope" } },
              },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execDo({
          resumeFrom: 2,
          steps: [
            { action: "wait", amount: 1 },
            { action: "wait", amount: 1 },
            { action: "click", query: "A", allowUnverified: true },
            { action: "run_command", command: "ls" },
          ],
        }),
      )
      expect(result.title).toBe("Plan stopped at step 4/4")
      expect(result.output).toContain("unverified")
      expect(result.output).toContain("3. click")
      expect(result.output).toContain("4. run_command")
      expect(result.output).toContain("command_failed")
      expect(result.output).toContain("exitCode=1")
      expect(result.output).toContain("stderr=nope")
      expect(result.output).toContain("The plan stopped.")
    }),
  )

  it.instance("fails closed on unverified steps", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          result: {
            success: true,
            completed: 1,
            total: 1,
            message: "Completed 1 of 1 step(s).",
            steps: [
              {
                index: 0,
                action: "click",
                success: true,
                message: "Clicked.",
                verification: { status: "unverified", message: "No readback confirmed the click." },
              },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execDo({ steps: [{ action: "click", query: "Save" }] }),
      )
      expect((result.metadata as { success?: boolean }).success).toBe(false)
      expect((result.metadata as { completed?: number }).completed).toBe(0)
      expect(result.title).toBe("Plan stopped at step 1/1")
      expect(result.output).toContain("unverified")
      expect(result.output).toContain("fail closed")
      const sent = (mock.bodies[0]?.steps as Array<Record<string, unknown>> | undefined)?.[0]
      expect(sent !== undefined && "allowUnverified" in sent).toBe(false)
    }),
  )

  it.instance("passes unverified steps when allowUnverified is true", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          result: {
            success: true,
            completed: 1,
            total: 1,
            message: "Completed 1 of 1 step(s).",
            steps: [
              {
                index: 0,
                action: "click",
                success: true,
                message: "Clicked.",
                verification: { status: "unverified", message: "No readback confirmed the click." },
              },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execDo({ steps: [{ action: "click", query: "Save", allowUnverified: true }] }),
      )
      expect((result.metadata as { success?: boolean }).success).toBe(true)
      expect((result.metadata as { completed?: number }).completed).toBe(1)
      expect(result.title).toBe("Plan complete (1/1)")
      expect(result.output).toContain("unverified")
      expect((mock.bodies[0]?.steps as Array<Record<string, unknown>> | undefined)?.[0]).toMatchObject({
        allowUnverified: true,
      })
    }),
  )

  it.instance("treats expect.text as met when the step output contains it", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: false,
          result: {
            success: false,
            completed: 1,
            total: 3,
            failedAt: 1,
            message: 'Step 2 (get_cursor) failed: Expected text "The pointer" did not appear.',
            steps: [
              { index: 0, action: "wait", success: true, verification: { status: "verified" } },
              {
                index: 1,
                action: "get_cursor",
                success: false,
                message: "The pointer is at 10,20.",
                error: { code: "expectation_unmet", message: 'Expected text "The pointer" did not appear.' },
              },
              { index: 2, action: "wait", success: true, verification: { status: "verified" } },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execDo({
          stopOnError: false,
          steps: [
            { action: "wait", amount: 1 },
            { action: "get_cursor", expect: { text: "The pointer" } },
            { action: "wait", amount: 1 },
          ],
        }),
      )
      expect(result.title).toBe("Plan complete (3/3)")
      expect(result.output).toContain("The pointer is at 10,20.")
      expect(result.output).toContain("verified")
      expect(result.output).not.toContain("expectation_unmet")
      expect(result.output).not.toContain("The plan stopped")
      expect((result.metadata as { success?: boolean }).success).toBe(true)
      expect((result.metadata as { completed?: number }).completed).toBe(3)
    }),
  )

  it.instance("completes a plan whose expect.text the server verified from the step output", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          result: {
            success: true,
            completed: 1,
            total: 1,
            message: "Completed 1 of 1 step(s).",
            steps: [
              {
                index: 0,
                action: "get_cursor",
                success: true,
                message: "The pointer is at 500,600.",
                verification: { status: "verified" },
              },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execDo({ steps: [{ action: "get_cursor", expect: { text: "500,600" } }] }),
      )
      expect(result.title).toBe("Plan complete (1/1)")
      expect(result.output).toContain("The pointer is at 500,600.")
      expect(result.output).not.toContain("expectation_unmet")
      expect((result.metadata as { success?: boolean }).success).toBe(true)
    }),
  )

  it.instance("does not satisfy expect.text from the expectation failure message", () =>
    Effect.gen(function* () {
      resetMock()
      const unmet = 'Expected text "The pointer" was not found in the interface or the step output.'
      mock.handler = (req) =>
        respond(req, {
          ok: false,
          result: {
            success: false,
            completed: 0,
            total: 1,
            failedAt: 0,
            message: `Step 1 (get_cursor) failed: ${unmet}`,
            steps: [
              {
                index: 0,
                action: "get_cursor",
                success: false,
                message: unmet,
                error: { code: "expectation_unmet", message: unmet },
              },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execDo({ steps: [{ action: "get_cursor", expect: { text: "The pointer" } }] }),
      )
      expect(result.output).toContain("expectation_unmet")
      expect(result.output).toContain("The plan stopped.")
      expect((result.metadata as { success?: boolean }).success).toBe(false)
    }),
  )

  it.instance("reports completion with failed steps when stopOnError is false", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: false,
          result: {
            success: false,
            completed: 1,
            total: 3,
            message: "Completed 1 of 3 step(s).",
            steps: [
              { index: 0, action: "wait", success: true, verification: { status: "verified" } },
              { index: 1, action: "click", success: false, error: { code: "target_not_found", message: "No match." } },
              { index: 2, action: "click", success: false, error: { code: "target_not_found", message: "No match." } },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execDo({
          stopOnError: false,
          steps: [
            { action: "wait", amount: 1 },
            { action: "click", query: "A" },
            { action: "click", query: "B" },
          ],
        }),
      )
      expect(result.title).toBe("Plan completed with 2 failed steps (1 of 3)")
      expect(result.output).toContain("The plan completed with 2 failed steps (1 of 3).")
      expect(result.output).not.toContain("The plan stopped")
      expect((result.metadata as { failedAt?: number }).failedAt).toBe(1)
      expect((result.metadata as { success?: boolean }).success).toBe(false)
    }),
  )

  it.instance("marks preview substitution as truncated and widens the server limit instead of sending offset", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          result: { success: true, metadata: { preview: "hello world", length: 100, hash: "abc" } },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execRead({ target: "atspi:1", observationId: "obs-9", offset: 6, limit: 5 }),
      )
      // The server honours limit and ignores offset, so the window is fetched by
      // asking for every character up to its end and cut once on the way back.
      expect(mock.bodies[0].offset).toBeUndefined()
      expect(mock.bodies[0].limit).toBe(11)
      expect(mock.bodies[0].observationId).toBe("obs-9")
      expect(mock.bodies[0].target).toEqual({ elementId: "atspi:1", observationId: "obs-9" })
      expect(result.output).toContain("truncated=true")
      expect(result.output).toContain("offset=6")
      expect(result.output).toContain("world")
    }),
  )

  it.instance("slices full text reads with offset", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) => respond(req, { ok: true, result: { success: true, text: "0123456789", length: 10 } })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execRead({ target: "atspi:1", offset: 4, limit: 3 }),
      )
      expect(mock.bodies[0].limit).toBe(7)
      expect(result.output).toContain("456")
      expect(result.output).toContain("returned=3")
      expect(result.output).toContain("truncated=true")
    }),
  )

  it.instance("reports a server-limited read as truncated even when the server sends no flag", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          result: { success: true, text: "abcdefghij", length: 10, metadata: { preview: "abcde" } },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execRead({ target: "atspi:1", limit: 10 }))
      expect(result.output).toContain("length=10")
      expect(result.output).toContain("returned=10")
      expect(result.output).toContain("truncated=true")
      expect(result.output).toContain("offset: 10")
    }),
  )

  it.instance("returns an empty window past the end without claiming truncation", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) => respond(req, { ok: true, result: { success: true, text: "0123456789", length: 10 } })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execRead({ target: "atspi:1", offset: 10, limit: 5 }),
      )
      expect(result.output).toContain("returned=0")
      expect(result.output).toContain("truncated=false")
      expect(result.output).not.toContain("offset:")
    }),
  )

  it.instance("passes method scopes when calling a superskill", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        req.method === "GET"
          ? respond(req, { ok: true, superskill: { methods: [{ name: "doThing", scopes: ["NETWORK"] }] } })
          : respond(req, { ok: true, result: { value: 1 } })
      yield* withEnv({ computerId: "test-computer" }, () =>
        execSuperskill({ action: "call", skill: "skill-1", method: "doThing" }),
      )
      expect(mock.asked[0].always).toEqual(["superskill:call:*"])
      expect(mock.bodies[0].approvedScopes).toEqual(["NETWORK"])
      expect(mock.bodies[0].approve).toBe(true)
    }),
  )

  it.instance("requests the scopes get_context needs together, not UI_READ alone", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, { ok: true, result: { success: true, metadata: { activeWindow: { name: "Editor" } } } })
      yield* withEnv({ computerId: "test-computer" }, () => execContext())
      expect(mock.bodies[0].action).toBe("get_context")
      expect(mock.bodies[0].approvedScopes).toEqual(["UI_READ", "POINTER", "BROWSER"])
    }),
  )

  it.instance("renders a denied superskill call as a failure instead of success", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        req.method === "GET"
          ? respond(req, { ok: true, superskill: { bridge: { type: "stdio" }, methods: [{ name: "doThing" }] } })
          : respond(
              req,
              {
                ok: false,
                result: {
                  success: false,
                  message: "Permission required.",
                  error: {
                    code: "permission_required",
                    message: "PROCESS_EXECUTE has not been approved.",
                    details: { missing: ["PROCESS_EXECUTE"] },
                  },
                },
              },
              428,
            )
      const exit = yield* withEnv({ computerId: "test-computer" }, () =>
        execSuperskill({ action: "call", skill: "skill-1", method: "doThing" }),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(message).toContain("PROCESS_EXECUTE has not been approved.")
      expect(message).toContain("missing scopes: PROCESS_EXECUTE")
    }),
  )

  it.instance("renders a denied superskill save as a failure instead of crashing", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(
          req,
          {
            ok: false,
            result: {
              success: false,
              message: "Permission required.",
              error: { code: "permission_required", message: "Approval was refused." },
            },
          },
          428,
        )
      const exit = yield* withEnv({ computerId: "test-computer" }, () =>
        execSuperskill({ action: "save", definition: { id: "skill-1", name: "One" } }),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("Approval was refused.")
    }),
  )

  it.instance("renders a denied superskill delete as a failure instead of a silent no-op", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(
          req,
          {
            ok: false,
            result: {
              success: false,
              message: "Permission required.",
              error: { code: "permission_required", message: "Delete was not approved." },
            },
          },
          428,
        )
      const exit = yield* withEnv({ computerId: "test-computer" }, () =>
        execSuperskill({ action: "delete", skill: "skill-1" }),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("Delete was not approved.")
    }),
  )

  it.instance("still reports a bridge payload that looks like a failure envelope", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        req.method === "GET"
          ? respond(req, { ok: true, superskill: { methods: [{ name: "check", scopes: ["NETWORK"] }] } })
          : respond(req, { ok: true, result: { success: false, rows: 0 } })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execSuperskill({ action: "call", skill: "skill-1", method: "check" }),
      )
      expect(result.metadata.success).toBe(true)
      expect(result.output).toContain('"rows":0')
    }),
  )

  it.instance("forwards the credential field so a username step is not typed as a secret", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, { ok: true, result: { success: true, total: 1, completed: 1, steps: [], message: "done" } })
      yield* withEnv({ computerId: "test-computer" }, () =>
        execDo({ steps: [{ action: "type", query: "Email", credential: "auto", field: "username" }] }),
      )
      expect((mock.bodies[0].steps as Record<string, unknown>[])[0]).toMatchObject({
        action: "type",
        credential: "auto",
        field: "username",
      })
    }),
  )

  it.instance("leaves field absent when the plan does not set it", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, { ok: true, result: { success: true, total: 1, completed: 1, steps: [], message: "done" } })
      yield* withEnv({ computerId: "test-computer" }, () =>
        execDo({ steps: [{ action: "type", query: "Email", credential: "auto" }] }),
      )
      expect((mock.bodies[0].steps as Record<string, unknown>[])[0].field).toBeUndefined()
    }),
  )

  it.instance("caches the resolved computer id between calls", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        req.url.endsWith("/v1/computers")
          ? respond(req, { ok: true, computers: [{ id: "cached-computer", connected: true }] })
          : respond(req, { ok: true, result: { success: true } })
      yield* withEnv({ url: "http://127.0.0.1:8" }, () =>
        Effect.gen(function* () {
          yield* execAct({ action: "wait" })
          yield* execAct({ action: "wait" })
        }),
      )
      expect(mock.urls.filter((url) => url.endsWith("/v1/computers"))).toHaveLength(1)
      expect(mock.bodies).toHaveLength(2)
    }),
  )

  it.instance("refuses to select a disconnected computer", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        req.url.endsWith("/v1/computers")
          ? respond(req, { ok: true, computers: [{ id: "offline", connected: false }] })
          : respond(req, { ok: true, result: { success: true } })
      const exit = yield* withEnv({ url: "http://127.0.0.1:7" }, () => execAct({ action: "wait" })).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(message).toContain("No computer is connected")
      expect(mock.bodies).toHaveLength(0)
    }),
  )

  it.instance("selects the connected computer when several are reported", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        req.url.endsWith("/v1/computers")
          ? respond(req, {
              ok: true,
              computers: [
                { id: "offline", connected: false },
                { id: "online", connected: true },
              ],
            })
          : respond(req, { ok: true, result: { success: true } })
      yield* withEnv({ url: "http://127.0.0.1:6" }, () => execAct({ action: "wait" }))
      expect(mock.urls.some((url) => url.includes("/v1/computers/online/actions"))).toBe(true)
      expect(mock.urls.some((url) => url.includes("/v1/computers/offline/"))).toBe(false)
    }),
  )

  it.instance("signs requests carrying a session id with a session proof", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) => respond(req, { ok: true, result: { success: true } })
      yield* withEnv({ computerId: "test-computer" }, () => execAct({ action: "wait" }))
      expect(mock.proofs).toHaveLength(1)
      expect(mock.proofs[0]).toBe(createHmac("sha256", "test-token").update("ses_test").digest("hex"))
      expect(mock.proofs[0]).toMatch(/^[0-9a-f]{64}$/)
    }),
  )

  it.instance("forwards a find window filter", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) => respond(req, { ok: true, result: { matches: [], observation: { id: "obs-1" } } })
      yield* withEnv({ computerId: "test-computer" }, () =>
        execFind({ query: "Export", window: "Writer", role: "button", limit: 3 }),
      )
      expect(mock.bodies[0]).toMatchObject({ query: "Export", window: "Writer", role: "button", limit: 3 })
    }),
  )

  it.instance("guards object application metadata when rendering observed windows", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          observation: {
            id: "obs-2",
            elements: [
              { id: "w1", role: "window", name: "Editor", metadata: { application: { name: "soffice" } }, states: [] },
              { id: "el-1", role: "button", name: "Save", metadata: { application: { name: "soffice" } } },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execObserve({}))
      expect(result.output).toContain('1. soffice — "Editor"')
      expect(result.output).toContain('- button "Save" ref=el-1')
      expect(result.output).not.toContain("[object Object]")
      expect(result.output).not.toContain("applications:")
    }),
  )

  it.instance("orders the focused window first and actionable controls ahead of inert text", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          observation: {
            id: "obs-20",
            elements: [
              {
                id: "w-panel",
                role: "window",
                name: "Panel",
                metadata: { application: "panel" },
                bounds: { x: 0, y: 900, width: 1920, height: 100 },
              },
              {
                id: "w-main",
                role: "window",
                name: "Editor",
                states: ["focused"],
                metadata: { application: "soffice" },
                bounds: { x: 0, y: 0, width: 1900, height: 800 },
              },
              {
                id: "el-title",
                role: "label",
                name: "Untitled",
                bounds: { x: 10, y: 10, width: 200, height: 20 },
                metadata: { application: "soffice" },
              },
              {
                id: "el-save",
                role: "button",
                name: "Save",
                states: ["enabled"],
                actions: ["click"],
                bounds: { x: 200, y: 100, width: 60, height: 24 },
                metadata: { application: "soffice" },
              },
              {
                id: "el-name",
                role: "textbox",
                name: "Name",
                states: ["enabled", "focused"],
                actions: ["set-value"],
                bounds: { x: 10, y: 100, width: 150, height: 24 },
                metadata: { application: "soffice" },
              },
              {
                id: "el-reload",
                role: "button",
                name: "Reload",
                states: ["enabled"],
                actions: ["click"],
                bounds: { x: 1000, y: 100, width: 60, height: 24 },
                metadata: { application: "panel" },
              },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execObserve({ focusFirst: false }))
      const lines = result.output.split("\n")
      const editor = lines.findIndex((line) => line.includes('"Editor"'))
      const panel = lines.findIndex((line) => line.includes('"Panel"'))
      const body = lines.slice(editor)
      const name = body.findIndex((line) => line.includes("ref=el-name"))
      const save = body.findIndex((line) => line.includes("ref=el-save"))
      const title = body.findIndex((line) => line.includes("ref=el-title"))
      expect(lines[editor]).toBe('1. soffice — "Editor" [focused] @0,0 1900x800 ref=w-main')
      expect(lines[panel]).toBe('2. panel — "Panel" @0,900 1920x100 ref=w-panel')
      expect(editor).toBeLessThan(panel)
      // Actionable first, then reading order inside that group, inert text last
      // even though the label sits higher on screen.
      expect(name).toBeLessThan(save)
      expect(save).toBeLessThan(title)
      expect(body[name]).toBe('  - textbox "Name" ref=el-name @22,112 [enabled, focused] actions=set-value')
      expect(body[save]).toBe('  - button "Save" ref=el-save @230,112 [enabled] actions=click')
      expect(body[title]).toBe('  - label "Untitled" ref=el-title @110,20 (bounds-center)')
      expect(body[panel - editor]).toBe('2. panel — "Panel" @0,900 1920x100 ref=w-panel')
      expect(body[panel - editor + 1]).toBe('  - button "Reload" ref=el-reload @1030,112 [enabled] actions=click')
    }),
  )

  it.instance("focusFirst lists only the focused window and reports what it skipped", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          observation: {
            id: "obs-22",
            elements: [
              {
                id: "w-editor",
                role: "window",
                name: "Editor",
                states: ["focused"],
                metadata: { application: "soffice" },
              },
              { id: "w-browser", role: "window", name: "Firefox", metadata: { application: "firefox" } },
              {
                id: "el-save",
                role: "button",
                name: "Save",
                states: ["enabled", "focused"],
                actions: ["click"],
                metadata: { application: "soffice" },
              },
              {
                id: "el-reload",
                role: "button",
                name: "Reload",
                states: ["enabled"],
                actions: ["click"],
                metadata: { application: "firefox" },
              },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execObserve({}))
      expect(result.output).toContain('1. soffice — "Editor" [focused]')
      expect(result.output).toContain('- button "Save" ref=el-save')
      expect(result.output).not.toContain("w-browser")
      expect(result.output).not.toContain("el-reload")
      expect(result.output).toContain(
        "… 1 control outside the focused window not shown — re-run with focusFirst: false, narrow with applicationId or window, or use computer_find",
      )
      expect(result.output).toContain('focused: button "Save" ref=el-save')
    }),
  )

  it.instance("reports dropped controls per window instead of truncating silently", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          observation: {
            id: "obs-23",
            elements: [
              { id: "w1", role: "window", name: "Writer", states: ["focused"], metadata: { application: "soffice" } },
              ...Array.from({ length: 5 }, (_, index) => ({
                id: `atspi:${index}`,
                role: "button",
                name: `Button ${index}`,
                states: ["enabled"],
                actions: ["click"],
                metadata: { application: "soffice" },
              })),
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execObserve({ limit: 2 }))
      expect(result.output).toContain(
        "… 3 elements omitted in this window — use computer_snapshot with limit/offset or computer_find by name",
      )
      expect(result.output).toContain("ref=atspi:0")
      expect(result.output).not.toContain("ref=atspi:3")
      expect(result.output).toContain("5 controls · 2 shown")
      expect((result.metadata as { truncated?: boolean }).truncated).toBe(true)
      expect((result.metadata as { dropped?: number }).dropped).toBe(3)
    }),
  )

  it.instance("reports windows dropped by the window cap", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          observation: {
            id: "obs-24",
            elements: Array.from({ length: CAPS.observeWindows + 1 }, (_, index) => ({
              id: `w${index}`,
              role: "window",
              name: `Window ${index}`,
              metadata: { application: `app${index}` },
            })),
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execObserve({}))
      expect(result.output).toContain("focus: no window reported focus — listing every window")
      expect(result.output).toContain(
        "… 1 window omitted — narrow with applicationId or window, or page with computer_snapshot limit/offset",
      )
      expect((result.metadata as { truncated?: boolean }).truncated).toBe(true)
    }),
  )

  it.instance("groups controls under the window reference the backend reports", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          observation: {
            id: "obs-27",
            elements: [
              { id: "w1", role: "window", name: "Writer", states: ["focused"], metadata: { application: "soffice" } },
              { id: "w2", role: "window", name: "Inbox", metadata: { application: "firefox" } },
              { id: "w2/el-1", role: "button", name: "Compose", states: ["enabled"], actions: ["click"] },
              {
                id: "el-2",
                role: "button",
                name: "Save",
                states: ["enabled"],
                actions: ["click"],
                metadata: { windowRef: "w1" },
              },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execObserve({ focusFirst: false }))
      const lines = result.output.split("\n")
      const writer = lines.findIndex((line) => line.startsWith("1. soffice"))
      const inbox = lines.findIndex((line) => line.startsWith("2. firefox"))
      expect(writer).toBeGreaterThanOrEqual(0)
      expect(inbox).toBeGreaterThan(writer)
      expect(lines[writer + 1]).toBe('  - button "Save" ref=el-2 [enabled] actions=click')
      expect(lines[inbox + 1]).toBe('  - button "Compose" ref=w2/el-1 [enabled] actions=click')
    }),
  )

  it.instance("banners a degraded accessibility tree and points at computer_screenshot", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          observation: {
            id: "obs-25",
            capabilities: { accessibility: "degraded" },
            elements: [
              { id: "w1", role: "window", name: "Editor", states: ["focused"], metadata: { application: "soffice" } },
              {
                id: "el-1",
                role: "button",
                name: "Save",
                states: ["enabled"],
                actions: ["click"],
                metadata: { application: "soffice" },
              },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execObserve({}))
      expect(result.output.split("\n")[1]).toBe(
        "accessibility: degraded — the accessibility tree is incomplete, so some controls are invisible in this list; confirm with computer_screenshot.",
      )
      expect(result.output).toContain("computer_screenshot")
      expect((result.metadata as { accessibility?: string }).accessibility).toBe("degraded")
    }),
  )

  it.instance("banners an unavailable accessibility tree", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          observation: {
            id: "obs-26",
            capabilities: { accessibility: "unavailable" },
            elements: [
              { id: "w1", role: "window", name: "Editor", states: ["focused"], metadata: { application: "soffice" } },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execObserve({}))
      expect(result.output).toContain(
        "accessibility: unavailable — no accessibility tree is available; use computer_screenshot to see the screen.",
      )
    }),
  )

  it.instance("dedupes observed windows into applications", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          observation: {
            id: "obs-3",
            elements: [
              {
                id: "w1",
                role: "window",
                name: "Writer",
                states: ["focused"],
                metadata: { application: "soffice" },
              },
              { id: "w2", role: "window", name: "Calc", metadata: { application: "soffice" } },
              { id: "w3", role: "window", name: "Inbox", metadata: { application: "firefox" } },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execApps())
      expect(result.title).toBe("2 open applications")
      expect(result.output).toContain("- soffice: 2 windows")
      expect(result.output).toContain("  - Writer (focused)")
      expect(result.output).toContain("- firefox: 1 window")
      expect((result.metadata as { applications?: number }).applications).toBe(2)
      expect((result.metadata as { windows?: number }).windows).toBe(3)
    }),
  )

  it.instance("degrades the capability report when one half fails", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        req.url.endsWith("/v1/health")
          ? respond(req, {
              ok: true,
              health: {
                status: "ok",
                version: "1.2.3",
                protocol: 1,
                uptimeMs: 1000,
                connectedComputers: 1,
                subsystems: [{ name: "browser", status: "up" }],
              },
            })
          : respond(req, { ok: false, error: "computer offline" }, 503)
      const result = yield* withEnv({ computerId: "test-computer" }, () => execCapabilities())
      expect(result.title).toBe("Computer capabilities (incomplete)")
      expect(result.output).toContain("Omnia Server 1.2.3")
      expect(result.output).toContain("server.browser: up")
      expect(result.output).toContain("computer details unavailable")
      expect(result.output).toContain("computer offline")
      expect((result.metadata as { degraded?: boolean }).degraded).toBe(true)
    }),
  )

  it.instance("renders memory failures through the shared error renderer", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(
          req,
          {
            ok: false,
            result: {
              success: false,
              message: "Memory access was denied.",
              error: { code: "permission_denied", details: { missing: ["FILES_READ"] } },
            },
          },
          403,
        )
      const exit = yield* withEnv({ computerId: "test-computer" }, () => execMemory({ action: "list" })).pipe(
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(message).toContain("Memory access was denied.")
      expect(message).toContain("[permission_denied]")
      expect(message).toContain("missing scopes: FILES_READ; ask the user to approve them.")
    }),
  )

  it.instance("forwards a validated screenshot region", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) => respond(req, { ok: true, result: { success: true } })
      yield* withEnv({ computerId: "test-computer" }, () =>
        execScreenshot({ region: { x: 1, y: 2, width: 30, height: 40 } }),
      )
      expect(mock.bodies[0].region).toEqual({ x: 1, y: 2, width: 30, height: 40 })
    }),
  )
})

describe("computer snapshot", () => {
  it.instance("returns formatted JSON with stable refs for every control", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          observation: {
            id: "obs-9",
            elements: [
              {
                id: "w1",
                role: "window",
                name: "Writer",
                states: ["focused"],
                bounds: { x: 0, y: 0, width: 800, height: 600 },
                metadata: { application: "soffice" },
              },
              {
                id: "atspi:1",
                role: "button",
                name: "Save",
                states: ["enabled"],
                actions: ["click"],
                bounds: { x: 10, y: 10, width: 60, height: 24 },
                metadata: { application: "soffice" },
              },
              {
                id: "atspi:2",
                role: "textbox",
                name: "Name",
                value: "Ada",
                states: ["enabled", "focused"],
                actions: ["set-text"],
                metadata: { application: "soffice" },
              },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execSnapshot({ app: "soffice" }))
      const parsed = JSON.parse(result.output) as {
        observationId?: string
        application?: string
        totalElements?: number
        truncated?: boolean
        focusedRef?: string
        windows?: Array<{ ref?: string; application?: string; focused?: boolean }>
        elements?: Array<{ ref?: string; role?: string; value?: string }>
        warnings?: string[]
      }
      expect(parsed.observationId).toBe("obs-9")
      expect(parsed.application).toBe("soffice")
      expect(parsed.totalElements).toBe(2)
      expect(parsed.truncated).toBe(false)
      expect(parsed.focusedRef).toBe("w1")
      expect(parsed.windows).toHaveLength(1)
      expect(parsed.windows?.[0]).toMatchObject({ ref: "w1", application: "soffice", focused: true })
      expect(parsed.elements?.map((element) => element.ref)).toEqual(["atspi:1", "atspi:2"])
      expect(parsed.elements?.[1]).toMatchObject({ role: "textbox", value: "Ada" })
      expect(result.metadata).toMatchObject({ observationId: "obs-9", elementCount: 2, truncated: false })
      expect(mock.asked[0].patterns).toEqual(["snapshot:soffice"])
    }),
  )

  it.instance("pages elements with offset and reports truncation honestly", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          observation: {
            id: "obs-10",
            elements: Array.from({ length: 5 }, (_, index) => ({
              id: `atspi:${index}`,
              role: "button",
              name: `Button ${index}`,
            })),
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execSnapshot({ limit: 2, offset: 1 }))
      const parsed = JSON.parse(result.output.split("\n…")[0]) as {
        totalElements?: number
        returnedElements?: number
        truncated?: boolean
        elements?: Array<{ ref?: string }>
      }
      expect(parsed.totalElements).toBe(5)
      expect(parsed.returnedElements).toBe(2)
      expect(parsed.truncated).toBe(true)
      expect(parsed.elements?.map((element) => element.ref)).toEqual(["atspi:1", "atspi:2"])
      expect(result.output).toContain("offset=3")
      expect((result.metadata as { truncated?: boolean }).truncated).toBe(true)
    }),
  )

  it.instance("keeps oversized snapshots valid JSON", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          observation: {
            id: "obs-11",
            elements: [{ id: "atspi:1", role: "document", name: "Big", text: "x".repeat(CAPS.snapshotChars + 10) }],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execSnapshot({}))
      const parsed = JSON.parse(result.output.split("\n…")[0]) as { truncated?: boolean }
      expect(parsed.truncated).toBe(true)
      expect((result.metadata as { truncated?: boolean }).truncated).toBe(true)
    }),
  )

  it.instance("precomputes an aim point on actionable elements and omits it on the rest", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          observation: {
            id: "obs-12",
            elements: [
              {
                id: "atspi:1",
                role: "button",
                name: "Close",
                actions: ["click"],
                bounds: { x: 900, y: 10, width: 40, height: 20 },
              },
              {
                id: "atspi:2",
                role: "textfield",
                name: "Command",
                actions: ["focus", "set_value"],
                bounds: { x: 10, y: 40, width: 800, height: 24 },
              },
              { id: "atspi:3", role: "label", name: "Status", bounds: { x: 3, y: 4, width: 50, height: 20 } },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execSnapshot({}))
      const parsed = JSON.parse(result.output.split("\n…")[0]) as {
        truncated?: boolean
        elements?: Array<{ ref?: string; aim?: { x?: number; y?: number; strategy?: string } }>
        warnings?: Array<string | { elementRef?: string; reason?: string }>
      }
      const byRef = new Map((parsed.elements ?? []).map((element) => [element.ref, element]))
      expect(parsed.truncated).toBe(false)
      expect(byRef.get("atspi:1")?.aim).toEqual({ x: 900, y: 20, strategy: "role-inset" })
      expect(byRef.get("atspi:2")?.aim).toEqual({ x: 410, y: 52, strategy: "control-center" })
      expect(byRef.get("atspi:3")?.aim).toBeUndefined()
      expect(parsed.warnings).toEqual([])
      expect((result.metadata as { warnings?: unknown[] }).warnings).toEqual([])
    }),
  )

  it.instance("prefers a provider hint and a focus point over the role inset", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          observation: {
            id: "obs-13",
            elements: [
              {
                id: "atspi:1",
                role: "button",
                name: "Hinted",
                actions: ["click"],
                bounds: { x: 0, y: 0, width: 100, height: 40 },
                metadata: { aimHint: { x: 30, y: 12 } },
              },
              {
                id: "atspi:2",
                role: "slider",
                name: "Volume",
                actions: ["click"],
                bounds: { x: 0, y: 50, width: 100, height: 20 },
                focusPoint: { x: 40, y: 58 },
              },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execSnapshot({}))
      const parsed = JSON.parse(result.output.split("\n…")[0]) as {
        elements?: Array<{ ref?: string; aim?: { x?: number; y?: number; strategy?: string } }>
      }
      expect(parsed.elements?.[0]?.aim).toEqual({ x: 30, y: 12, strategy: "provider-hint" })
      expect(parsed.elements?.[1]?.aim).toEqual({ x: 40, y: 58, strategy: "focus-point" })
    }),
  )

  it.instance("records a warning instead of silently center-clicking an unknown role", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          observation: {
            id: "obs-14",
            elements: [
              {
                id: "atspi:1",
                role: "unknown",
                name: "Mystery",
                actions: ["click"],
                bounds: { x: 4, y: 6, width: 20, height: 10 },
              },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execSnapshot({}))
      const parsed = JSON.parse(result.output.split("\n…")[0]) as {
        elements?: Array<{ aim?: { x?: number; y?: number; strategy?: string } }>
        warnings?: Array<string | { elementRef?: string; reason?: string }>
      }
      expect(parsed.elements?.[0]?.aim).toEqual({ x: 14, y: 11, strategy: "bounds-center" })
      expect(parsed.warnings).toEqual([{ elementRef: "atspi:1", reason: "center-guess" }])
      expect((result.metadata as { warnings?: unknown[] }).warnings).toEqual([
        { elementRef: "atspi:1", reason: "center-guess" },
      ])
    }),
  )

  it.instance("caps warnings at twenty and marks the snapshot truncated", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          observation: {
            id: "obs-15",
            elements: Array.from({ length: 25 }, (_, index) => ({
              id: `atspi:${index}`,
              role: "unknown",
              name: `Mystery ${index}`,
              actions: ["click"],
              bounds: { x: index, y: 0, width: 10, height: 10 },
            })),
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execSnapshot({}))
      const parsed = JSON.parse(result.output.split("\n…")[0]) as {
        truncated?: boolean
        elements?: Array<{ aim?: { strategy?: string } }>
        warnings?: Array<string | { elementRef?: string; reason?: string }>
      }
      expect(parsed.warnings).toHaveLength(20)
      expect(
        parsed.warnings?.every((warning) => typeof warning !== "string" && warning.reason === "center-guess"),
      ).toBe(true)
      expect(parsed.truncated).toBe(true)
      expect((result.metadata as { truncated?: boolean }).truncated).toBe(true)
      expect((result.metadata as { warnings?: unknown[] }).warnings).toHaveLength(20)
      expect(parsed.elements?.every((element) => element.aim?.strategy === "bounds-center")).toBe(true)
    }),
  )

  it.instance("keeps the element cap while adding aim points", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          observation: {
            id: "obs-16",
            elements: Array.from({ length: CAPS.snapshotElements + 6 }, (_, index) => ({
              id: `atspi:${index}`,
              role: "button",
              name: `Button ${index}`,
              actions: ["click"],
              bounds: { x: 0, y: 0, width: 10, height: 10 },
            })),
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execSnapshot({}))
      const parsed = JSON.parse(result.output.split("\n…")[0]) as {
        totalElements?: number
        returnedElements?: number
        truncated?: boolean
        elements?: Array<{ aim?: { strategy?: string } }>
      }
      expect(parsed.totalElements).toBe(CAPS.snapshotElements + 6)
      expect(parsed.returnedElements).toBe(CAPS.snapshotElements)
      expect(parsed.elements).toHaveLength(CAPS.snapshotElements)
      expect(parsed.elements?.every((element) => element.aim?.strategy === "control-center")).toBe(true)
      expect(parsed.truncated).toBe(true)
      expect(result.output).toContain(`offset=${CAPS.snapshotElements}`)
    }),
  )
})

describe("computer client errors", () => {
  it.effect("preserves structured error code and details", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((req) =>
        respond(
          req,
          {
            ok: false,
            error: { code: "window_not_found", message: "No window matches", details: { windows: ["A", "B"] } },
          },
          404,
        ),
      )
      const exit = yield* request<unknown>(client, { url: "http://127.0.0.1:9", token: "t" }, "GET", "/v1/x").pipe(
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(message).toContain("No window matches")
      expect(message).toContain("window_not_found")
      expect(message).toContain("A")
    }),
  )

  it.effect("preserves the transport cause", () =>
    Effect.gen(function* () {
      const client = HttpClient.make(() => Effect.die(new Error("socket closed")))
      const exit = yield* request<unknown>(client, { url: "http://127.0.0.1:9", token: "t" }, "GET", "/v1/x").pipe(
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(message).toContain("socket closed")
    }),
  )

  it.effect("reports invalid JSON with status and size", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((req) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
          ),
        ),
      )
      const exit = yield* request<unknown>(client, { url: "http://127.0.0.1:9", token: "t" }, "GET", "/v1/x").pipe(
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(message).toContain("invalid JSON")
      expect(message).toContain("HTTP 200")
    }),
  )

  it.effect("rejects responses that fail validation", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((req) => respond(req, { ok: true }))
      const exit = yield* request<unknown>(
        client,
        { url: "http://127.0.0.1:9", token: "t" },
        "GET",
        "/v1/computers",
        undefined,
        {
          validate: (value) =>
            typeof value === "object" && value !== null && Array.isArray((value as { computers?: unknown }).computers),
        },
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(message).toContain("unexpected response")
    }),
  )

  it.effect("reports auth failures with an actionable message", () =>
    Effect.gen(function* () {
      const unauthorized = HttpClient.make((req) => respond(req, { ok: false }, 401))
      const unauthorizedExit = yield* request<unknown>(
        unauthorized,
        { url: "http://127.0.0.1:9", token: "t" },
        "GET",
        "/v1/x",
      ).pipe(Effect.exit)
      expect(Exit.isFailure(unauthorizedExit)).toBe(true)
      const unauthorizedMessage = Exit.isFailure(unauthorizedExit) ? Cause.pretty(unauthorizedExit.cause) : ""
      expect(unauthorizedMessage).toContain("HTTP 401")
      expect(unauthorizedMessage).toContain("token")

      const forbidden = HttpClient.make((req) => respond(req, { ok: false, error: "denied by policy" }, 403))
      const forbiddenExit = yield* request<unknown>(
        forbidden,
        { url: "http://127.0.0.1:9", token: "t" },
        "GET",
        "/v1/x",
      ).pipe(Effect.exit)
      expect(Exit.isFailure(forbiddenExit)).toBe(true)
      const forbiddenMessage = Exit.isFailure(forbiddenExit) ? Cause.pretty(forbiddenExit.cause) : ""
      expect(forbiddenMessage).toContain("denied by policy")
      expect(forbiddenMessage).toContain("approve")
    }),
  )
})

describe("computer aim targets", () => {
  it.instance("returns an aim strategy per candidate and rejects matches below the floor", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          result: {
            observation: { id: "obs-30" },
            matches: [
              {
                element: {
                  id: "atspi:7.2",
                  role: "close",
                  name: "Close",
                  states: ["enabled"],
                  actions: ["click"],
                  bounds: { x: 900, y: 10, width: 40, height: 20 },
                },
                reference: { elementId: "atspi:7.2", observationId: "obs-30" },
                score: 0.93,
              },
              {
                element: {
                  id: "atspi:7.9",
                  role: "mystery",
                  name: "Mystery",
                  actions: ["click"],
                  bounds: { x: 4, y: 6, width: 20, height: 10 },
                },
                score: 0.61,
              },
              { element: { id: "atspi:9.9", role: "label", name: "Export status" }, score: 0.3 },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execFind({ query: "Close" }))
      const lines = result.output.split("\n")
      expect(lines[0]).toBe(
        '1. close "Close" id=atspi:7.2 aim=935,20 strategy=role-inset [enabled] actions=click confidence=0.93 observation=obs-30',
      )
      expect(lines[1]).toContain("aim=14,11 strategy=bounds-center (guess)")
      expect(result.output).toContain("do not trust that point")
      expect(result.output).toContain("1 candidate rejected for scoring below the 0.6 confidence floor")
      expect(result.output).not.toContain("atspi:9.9")
      expect(result.metadata).toMatchObject({
        matches: 2,
        rejected: 1,
        best: { id: "atspi:7.2", aim: { x: 935, y: 20, strategy: "role-inset" } },
      })
    }),
  )

  it.instance("prefers a provider hint and a focus point over the role inset in find results", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          result: {
            matches: [
              {
                element: {
                  id: "atspi:1",
                  role: "button",
                  name: "Hinted",
                  actions: ["click"],
                  bounds: { x: 0, y: 0, width: 100, height: 40 },
                  metadata: { aimHint: { x: 30, y: 12 } },
                },
                score: 0.7,
              },
              {
                element: {
                  id: "atspi:2",
                  role: "slider",
                  name: "Volume",
                  actions: ["click"],
                  bounds: { x: 0, y: 50, width: 100, height: 20 },
                  focusPoint: { x: 40, y: 58 },
                },
                score: 0.66,
              },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execFind({ query: "controls" }))
      expect(result.output).toContain("aim=30,12 strategy=provider-hint")
      expect(result.output).toContain("aim=40,58 strategy=focus-point")
      expect((result.metadata as { rejected?: number }).rejected).toBe(0)
    }),
  )

  it.instance("refuses a find whose only candidate scores below the floor and counts it", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          result: {
            matches: [
              { element: { id: "atspi:1", role: "label", name: "Export status" }, score: 0.42 },
              { element: { id: "atspi:2", role: "label", name: "Exported" }, score: 0.2 },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execFind({ query: "Export" }))
      expect(result.title).toBe("No confident match for Export")
      expect(result.output).toContain("2 candidates were rejected for scoring below the floor")
      expect(result.output).not.toContain("aim=")
      expect(result.metadata).toMatchObject({ matches: 0, rejected: 2 })
    }),
  )

  it.instance("resolves a query read by ref and reports the parent chain and aim", () =>
    Effect.gen(function* () {
      resetMock()
      const commandRef = "cua:window/kitty/OC | Quick hello/3"
      mock.handler = (req) =>
        req.url.endsWith("/find")
          ? respond(req, {
              ok: true,
              result: {
                observation: { id: "obs-31" },
                matches: [
                  {
                    element: {
                      id: commandRef,
                      role: "textfield",
                      name: "Command",
                      states: ["enabled", "focused"],
                      actions: ["set_value"],
                      parentId: "cua:window/kitty/OC | Quick hello/2",
                      bounds: { x: 10, y: 40, width: 800, height: 24 },
                    },
                    reference: { elementId: commandRef, observationId: "obs-31" },
                    score: 0.91,
                  },
                  {
                    element: {
                      id: "cua:window/kitty/OC | Quick hello/8",
                      role: "unknown",
                      name: "Mystery",
                      bounds: { x: 4, y: 6, width: 20, height: 10 },
                    },
                    score: 0.55,
                  },
                ],
              },
            })
          : respond(req, { ok: true, result: { success: true, text: "ls", length: 2, hash: "hash-1" } })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execRead({ query: "Command" }))
      expect(mock.bodies[0]).toMatchObject({ query: "Command" })
      expect(mock.bodies[1]).toMatchObject({ action: "read_text", target: { elementId: commandRef } })
      expect(result.output).toBe(
        `read textfield "Command" ref=${commandRef} parent=cua:window/kitty/OC | Quick hello/2 aim=410,52 strategy=control-center confidence=0.91\nls\n\n[length=2 offset=0 returned=2 hash=hash-1 truncated=false]\n1 candidate scored below the 0.6 confidence floor and was not read.`,
      )
      expect(result.metadata).toMatchObject({
        success: true,
        ref: commandRef,
        parentRef: "cua:window/kitty/OC | Quick hello/2",
        aim: { x: 410, y: 52, strategy: "control-center" },
        rejected: 1,
      })
    }),
  )

  it.instance("labels a bounds-center read surface as a guess instead of a precise point", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        req.url.endsWith("/find")
          ? respond(req, {
              ok: true,
              result: {
                matches: [
                  {
                    element: {
                      id: "atspi:4",
                      role: "canvas",
                      name: "Plot",
                      actions: ["click"],
                      bounds: { x: 8, y: 6, width: 20, height: 10 },
                    },
                    score: 0.7,
                  },
                ],
              },
            })
          : respond(req, { ok: true, result: { success: true, text: "42", length: 2 } })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execRead({ query: "Plot" }))
      expect(result.output).toContain("aim=18,11 strategy=bounds-center — guess: do not trust this point")
      expect(result.output).toContain("re-resolve it by ref before acting on it")
    }),
  )

  it.instance("refuses a query read whose candidates all score below the floor", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, { ok: true, result: { matches: [{ element: { id: "atspi:1", role: "label" }, score: 0.31 }] } })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execRead({ query: "document text" }))
      expect(result.title).toBe("No confident surface for document text")
      expect(result.output).toContain("1 candidate was rejected for scoring below the floor")
      expect(mock.bodies).toHaveLength(1)
      expect(result.metadata).toMatchObject({ success: false, rejected: 1 })
    }),
  )

  it.instance("refuses an ambiguous query read instead of reading the top hit", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          result: {
            matches: [
              { element: { id: "atspi:1", role: "button", name: "Save" }, score: 0.9 },
              { element: { id: "atspi:2", role: "button", name: "Save" }, score: 0.86 },
            ],
          },
        })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execRead({ query: "Save" }))
      expect(result.title).toBe('Read of "Save" is ambiguous')
      expect(result.output).toContain('"Save" matched more than one surface')
      expect(result.output).toContain("atspi:1")
      expect(mock.bodies).toHaveLength(1)
      expect((result.metadata as { success?: boolean }).success).toBe(false)
    }),
  )

  it.instance("reports the aim, window, and parent ref for one inspected control", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        req.url.endsWith("/observe")
          ? respond(req, {
              ok: true,
              observation: {
                id: "obs-32",
                elements: [
                  {
                    id: "win_1",
                    role: "window",
                    name: "Writer",
                    states: ["focused"],
                    bounds: { x: 0, y: 0, width: 800, height: 600 },
                    metadata: { application: "soffice" },
                  },
                  {
                    id: "atspi:2",
                    role: "panel",
                    name: "Toolbar",
                    parentId: "win_1",
                    metadata: { windowRef: "win_1" },
                  },
                  {
                    id: "atspi:3",
                    role: "close",
                    name: "Close",
                    parentId: "atspi:2",
                    bounds: { x: 900, y: 10, width: 40, height: 20 },
                    metadata: { windowRef: "win_1" },
                  },
                ],
              },
            })
          : respond(req, {
              ok: true,
              result: {
                success: true,
                message: 'Inspected button "Close".',
                metadata: {
                  element: {
                    id: "atspi:3",
                    role: "close",
                    name: "Close",
                    application: "soffice",
                    states: ["enabled"],
                    actions: ["click"],
                    bounds: { x: 900, y: 10, width: 40, height: 20 },
                    center: { x: 920, y: 20 },
                  },
                  ancestors: [
                    { id: "atspi:2", role: "panel", name: "Toolbar" },
                    { id: "win_1", role: "window", name: "Writer" },
                  ],
                  children: [],
                },
              },
            })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execInspect({ target: "atspi:3" }))
      expect(result.output).toContain("bounds: x=900 y=10 40x20 center: 920,20")
      expect(result.output).toContain("aim: 935,20 (role-inset)")
      expect(result.output).not.toContain("guess")
      expect(result.output).toContain("parent: atspi:2")
      expect(result.output).toContain('window: "Writer" (soffice) @0,0 800x600 ref=win_1')
      expect(result.output).not.toContain("risk:")
      expect(result.output).toContain('ancestors: panel "Toolbar" > window "Writer"')
      expect(result.metadata).toMatchObject({
        success: true,
        aim: { x: 935, y: 20, strategy: "role-inset" },
        parentRef: "atspi:2",
        window: { ref: "win_1", title: "Writer", application: "soffice" },
      })
    }),
  )

  it.instance("labels a bounds-center inspect aim as a guess and reports the risk", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        req.url.endsWith("/observe")
          ? respond(req, {
              ok: true,
              observation: {
                id: "obs-33",
                elements: [
                  { id: "w1", role: "window", name: "Writer", states: ["focused"] },
                  { id: "atspi:5", role: "unknown", name: "Mystery", bounds: { x: 4, y: 6, width: 20, height: 10 } },
                ],
              },
            })
          : respond(req, {
              ok: true,
              result: {
                success: true,
                metadata: {
                  element: {
                    id: "atspi:5",
                    role: "unknown",
                    name: "Mystery",
                    actions: ["click"],
                    bounds: { x: 4, y: 6, width: 20, height: 10 },
                  },
                },
              },
            })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execInspect({ target: "atspi:5" }))
      expect(result.output).toContain("aim: 14,11 (bounds-center) — guess: do not trust this point, re-resolve")
      expect(result.output).toContain('risk: Aim (14, 11) resolved with strategy "bounds-center"')
      expect(result.metadata).toMatchObject({ aim: { x: 14, y: 11, strategy: "bounds-center" } })
    }),
  )

  it.instance("keeps the inspect answer when the window context cannot be observed", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        req.url.endsWith("/observe")
          ? Effect.die(new Error("observation unavailable"))
          : respond(req, {
              ok: true,
              result: {
                success: true,
                metadata: {
                  element: {
                    id: "atspi:6",
                    role: "button",
                    name: "Save",
                    bounds: { x: 10, y: 10, width: 60, height: 24 },
                  },
                },
              },
            })
      const result = yield* withEnv({ computerId: "test-computer" }, () => execInspect({ target: "atspi:6" }))
      expect(result.output).toContain('button "Save"')
      expect(result.output).toContain("aim: 40,22 (control-center)")
      expect(result.output).not.toContain("window:")
      expect(result.output).not.toContain("risk:")
    }),
  )
})

// Visual grounding answers over HTTP: the analyze response carries the decision,
// the result, the analysis context (screenshot + platform) and, when the action
// ran, the execution record with its post-action confirmation.
function visualResponder(options: {
  result: Record<string, unknown>
  execution?: Record<string, unknown>
  context?: Record<string, unknown>
  decision?: Record<string, unknown>
  windows?: Record<string, unknown>[]
}) {
  return (req: MockRequest) => {
    if (req.url.endsWith("/v1/computer-use/analyze"))
      return respond(req, {
        ok: options.result.success !== false,
        analysis: {
          decision: options.decision ?? { provider: "ui-tars", local: true },
          result: options.result,
          fallbacks: 0,
          ...(options.context === undefined ? {} : { context: options.context }),
        },
        ...(options.execution === undefined ? {} : { execution: options.execution }),
      })
    if (req.url.endsWith("/observe"))
      return respond(req, { ok: true, observation: { id: "obs-visual", elements: options.windows ?? [] } })
    return respond(req, { ok: true, result: { success: true } })
  }
}

const VISUAL_WINDOW = {
  role: "window",
  name: "Editor",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
}

const VISUAL_IMAGE_CONTEXT = { platform: "linux", image: { width: 1920, height: 1080 } }

describe("computer visual grounding", () => {
  it.instance("reports the coordinate space and scale the vision point was produced in", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = visualResponder({
        windows: [VISUAL_WINDOW],
        context: VISUAL_IMAGE_CONTEXT,
        result: {
          success: true,
          provider: "ui-tars",
          confidence: 0.82,
          action: { type: "click", target: { x: 400, y: 300, label: "Export button" } },
          evidence: ["model output: click(start_box='208,278')"],
        },
      })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execVisual({ operation: "click", target: "the Export button", execute: false }),
      )
      expect(result.output).toContain("coordinates: absolute logical screen pixels")
      expect(result.output).toContain("normalized-1000")
      expect(result.output).toContain("scale 1000")
      expect(result.output).toContain("1920x1080")
      expect(result.metadata).toMatchObject({
        coordinate: {
          space: "absolute",
          modelSpace: "normalized-1000",
          scale: 1000,
          screenshot: { width: 1920, height: 1080 },
        },
      })

      resetMock()
      mock.handler = visualResponder({
        windows: [VISUAL_WINDOW],
        context: VISUAL_IMAGE_CONTEXT,
        result: {
          success: true,
          provider: "ui-tars",
          confidence: 0.82,
          action: { type: "click", target: { x: 200, y: 150 } },
          evidence: [
            "retina: screenshot 1920x1080 to logical 960x540",
            "calibration: applied display profile to visual point",
          ],
        },
      })
      const converted = yield* withEnv({ computerId: "test-computer" }, () =>
        execVisual({ operation: "click", target: "the Export button", execute: false }),
      )
      expect(converted.output).toContain("retina-converted to logical 960x540")
      expect(converted.output).toContain("calibration profile")
      expect(converted.metadata).toMatchObject({
        coordinate: { logical: { width: 960, height: 540 }, calibrated: true },
      })
    }),
  )

  it.instance("reports the coordinate space as unverifiable when no screenshot dimensions arrive", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = visualResponder({
        windows: [VISUAL_WINDOW],
        result: {
          success: true,
          provider: "ui-tars",
          confidence: 0.5,
          action: { type: "click", target: { x: 400, y: 300 } },
        },
      })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execVisual({ operation: "click", target: "the Export button", execute: false }),
      )
      expect(result.output).toContain("no screenshot dimensions")
      expect((result.metadata as { coordinate?: { screenshot?: unknown } }).coordinate?.screenshot).toBeUndefined()
    }),
  )

  it.instance("refuses to ground onto a window title bar and reports the strip that rejected the point", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = visualResponder({
        windows: [VISUAL_WINDOW],
        context: VISUAL_IMAGE_CONTEXT,
        result: {
          success: true,
          provider: "ui-tars",
          confidence: 0.93,
          action: { type: "click", target: { x: 1843, y: 45, label: "Close" } },
        },
      })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execVisual({ operation: "click", target: "the Close button", execute: false }),
      )
      expect(result.title).toBe("Refused visual click (title_bar_ban)")
      expect((result.metadata as { refused?: boolean }).refused).toBe(true)
      expect((result.metadata as { error?: { code?: string } }).error?.code).toBe("title_bar_ban")
      expect(result.output).toContain("(1843, 45)")
      expect(result.output).toContain('window "Editor"')
      expect(result.output).toContain("top 120px strip")
      expect(result.output).toContain("no click landed")
      expect((result.metadata as { aim?: unknown }).aim).toBeUndefined()
      expect(result.output).not.toContain("aim:")
    }),
  )

  it.instance("discloses the execution when a title-bar point already landed and scales the strip to the window", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = visualResponder({
        windows: [{ role: "window", name: "Panel", bounds: { x: 0, y: 800, width: 1280, height: 280 } }],
        context: { platform: "linux", image: { width: 1280, height: 1080 } },
        result: {
          success: true,
          provider: "ui-tars",
          confidence: 0.71,
          action: { type: "click", target: { x: 1200, y: 830 } },
        },
        execution: { outcome: { result: { success: true, message: "Clicked at 1200,830." } }, verified: false },
      })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execVisual({ operation: "click", target: "the window menu" }),
      )
      expect((result.metadata as { refused?: boolean }).refused).toBe(true)
      expect((result.metadata as { executed?: boolean }).executed).toBe(true)
      expect(result.output).toContain("top 48px strip")
      expect(result.output).toContain("already executed")
      expect(result.output).toContain("re-observe with computer_observe")
    }),
  )

  it.instance("keeps a point below the title strip and names the vision-ground aim when the click lands", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = visualResponder({
        windows: [VISUAL_WINDOW],
        context: VISUAL_IMAGE_CONTEXT,
        result: {
          success: true,
          provider: "ui-tars",
          confidence: 0.8,
          action: { type: "click", target: { x: 410, y: 312, label: "Export" } },
        },
        execution: { outcome: { result: { success: true, message: "Clicked." } }, verified: false },
      })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execVisual({ operation: "click", target: "the Export button" }),
      )
      expect((result.metadata as { refused?: boolean }).refused).toBeUndefined()
      expect(result.metadata).toMatchObject({
        aim: { x: 410, y: 312, strategy: "vision-ground" },
        executed: true,
      })
      expect(result.output).toContain("aim: 410,312 (vision-ground)")
      expect(result.output).toContain("not a resolved control")
    }),
  )

  it.instance("never marks a vision result verified on the model's confidence or the execution record", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = visualResponder({
        windows: [VISUAL_WINDOW],
        context: VISUAL_IMAGE_CONTEXT,
        result: {
          success: true,
          provider: "ui-tars",
          confidence: 0.99,
          action: { type: "click", target: { x: 410, y: 312 } },
        },
        execution: {
          outcome: {
            result: { success: true, message: "Clicked.", verification: { verified: true, status: "verified" } },
          },
          verified: true,
          confirmation: { status: "verified", method: "execution-verification" },
        },
      })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execVisual({ operation: "click", target: "the Export button" }),
      )
      expect((result.metadata as { verified?: boolean }).verified).toBe(false)
      expect((result.metadata as { verification?: string }).verification).toBe("not_verified")
      expect((result.metadata as { verificationMethod?: string }).verificationMethod).toBe("execution-verification")
      expect(result.output).toContain("Not verified (execution-verification)")
      expect(result.output).toContain("computer_observe")
      expect(result.output).not.toContain("Verified by observation")
    }),
  )

  it.instance("reports verified only when a post-action observation confirms the effect", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = visualResponder({
        windows: [VISUAL_WINDOW],
        context: VISUAL_IMAGE_CONTEXT,
        result: {
          success: true,
          provider: "ui-tars",
          confidence: 0.9,
          action: { type: "click", target: { x: 410, y: 312 } },
        },
        execution: {
          outcome: { result: { success: true, message: "Clicked." }, verified: true },
          verified: true,
          confirmation: {
            status: "verified",
            method: "element-state-change",
            observed: { ref: "atspi:3", states: ["focused"] },
          },
        },
      })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execVisual({ operation: "click", target: "the Export button" }),
      )
      expect((result.metadata as { verified?: boolean }).verified).toBe(true)
      expect((result.metadata as { verification?: string }).verification).toBe("verified")
      expect(result.output).toContain("Verified by post-action observation (element-state-change)")
      expect(result.output).toContain("ref atspi:3")
    }),
  )

  it.instance("leaves a proposal unverified and still labels its aim as vision-ground", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = visualResponder({
        windows: [VISUAL_WINDOW],
        context: VISUAL_IMAGE_CONTEXT,
        result: {
          success: true,
          provider: "ui-tars",
          confidence: 0.62,
          action: { type: "click", target: { x: 410, y: 312 } },
        },
      })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execVisual({ operation: "click", target: "the Export button", execute: false }),
      )
      expect(result.output).toContain("Proposal only")
      expect((result.metadata as { verified?: boolean }).verified).toBe(false)
      expect((result.metadata as { verificationMethod?: string }).verificationMethod).toBe("not_executed")
      expect(result.metadata).toMatchObject({ aim: { x: 410, y: 312, strategy: "vision-ground" } })
    }),
  )

  it.instance("says the title-strip check could not run when no window geometry is readable", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = (req) =>
        req.url.endsWith("/observe")
          ? Effect.die(new Error("observation unavailable"))
          : visualResponder({
              windows: [VISUAL_WINDOW],
              context: VISUAL_IMAGE_CONTEXT,
              result: {
                success: true,
                provider: "ui-tars",
                confidence: 0.75,
                action: { type: "click", target: { x: 1843, y: 45 } },
              },
            })(req)
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execVisual({ operation: "click", target: "the Close button", execute: false }),
      )
      expect((result.metadata as { refused?: boolean }).refused).toBeUndefined()
      expect(result.output).toContain("title-strip check could not run")
    }),
  )
})

// The session holds one tree per computer, so an identity is only ever
// addressable on the computer whose tree it was read from. This file cannot run
// switch_computer (it has no session service), so the other computer's tree is
// registered the way a switch registers what the session read off it.
const FOREIGN_COMPUTER = "computer-b"
const FOREIGN_OBSERVATION = "obs-computer-b"
const FOREIGN_ELEMENTS = [
  { id: "cua:window/kitty/OC | Quick hello/2/button/Close/1", role: "button", name: "Close" },
  { id: "atspi:9001", role: "button", name: "Quit" },
]

function holdOtherComputerTree() {
  recordObservation(FOREIGN_COMPUTER, FOREIGN_OBSERVATION, FOREIGN_ELEMENTS)
}

function errorCode(metadata: Record<string, unknown>): string | undefined {
  return (metadata.error as { code?: string } | undefined)?.code
}

describe("computer cross-computer refusals", () => {
  it.instance("refuses an act whose ref or observation came from another computer and names both", () =>
    Effect.gen(function* () {
      resetMock()
      holdOtherComputerTree()
      mock.handler = actResponder({ observationId: "obs-here" })
      // The ref and the observation it names both come from the other computer,
      // so acting on this one would act on that machine's control.
      const named = yield* withEnv({ computerId: "test-computer" }, () =>
        execAct({ action: "click", target: "atspi:9001", observationId: FOREIGN_OBSERVATION }),
      )
      expect((named.metadata as { refused?: boolean }).refused).toBe(true)
      expect(errorCode(named.metadata)).toBe("identity_not_for_this_computer")
      expect(named.output).toContain(FOREIGN_OBSERVATION)
      expect(named.output).toContain(`computer ${FOREIGN_COMPUTER}`)
      expect(named.output).toContain("computer test-computer")
      expect(mock.asked).toHaveLength(0)
      expect(actionBodies()).toHaveLength(0)
      // A bare ref only the other computer's tree carries is refused the same way.
      resetMock()
      mock.handler = actResponder({ observationId: "obs-here" })
      const bare = yield* withEnv({ computerId: "test-computer" }, () =>
        execAct({ action: "click", target: "atspi:9001" }),
      )
      expect((bare.metadata as { refused?: boolean }).refused).toBe(true)
      expect(bare.output).toContain(`computer ${FOREIGN_COMPUTER}`)
      expect(bare.output).toContain("computer test-computer")
      expect(mock.asked).toHaveLength(0)
      expect(actionBodies()).toHaveLength(0)
    }),
  )

  it.instance("still resolves a same-computer ref against the newest observation", () =>
    Effect.gen(function* () {
      resetMock()
      holdOtherComputerTree()
      mock.handler = actResponder({ observationId: "obs-newest" })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execAct({ action: "click", target: "cua:window/kitty/Editor/3/button/Minimize/1" }),
      )
      expect(mock.asked).toHaveLength(1)
      expect((result.metadata as { refused?: boolean }).refused).toBeUndefined()
      expect(result.metadata.success).toBe(true)
      expect(actionBodies()[0].target).toEqual({
        elementId: "cua:window/kitty/Editor/3/button/Minimize/1",
      })
    }),
  )

  it.instance("refuses an observation a switch invalidated instead of rebinding it", () =>
    Effect.gen(function* () {
      resetMock()
      mock.handler = actResponder({ observationId: "obs-before-switch" })
      yield* withEnv({ computerId: "test-computer" }, () => execAct({ action: "click", target: "atspi:1" }))
      expect(invalidateObservations("test-computer")).toBeGreaterThan(0)
      // The same computer is entered again through a fresh tree, so the ref that
      // died with the switch is refused rather than matched into the new one.
      resetMock()
      mock.handler = actResponder({ observationId: "obs-after-switch" })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execAct({ action: "click", target: "atspi:1", observationId: "obs-before-switch" }),
      )
      expect((result.metadata as { refused?: boolean }).refused).toBe(true)
      expect(result.output).toContain("invalidates")
      expect(result.output).toContain("computer test-computer")
      expect(actionBodies()).toHaveLength(0)
    }),
  )

  it.instance("refuses a read whose target came from another computer and names both", () =>
    Effect.gen(function* () {
      resetMock()
      holdOtherComputerTree()
      mock.handler = (req) =>
        respond(req, { ok: true, result: { success: true, text: "Quarterly report", length: 16 } })
      const result = yield* withEnv({ computerId: "test-computer" }, () =>
        execRead({ target: "atspi:9001", observationId: FOREIGN_OBSERVATION }),
      )
      expect(result.metadata.success).toBe(false)
      expect((result.metadata as { refused?: boolean }).refused).toBe(true)
      expect(errorCode(result.metadata)).toBe("identity_not_for_this_computer")
      expect(result.output).toContain(`computer ${FOREIGN_COMPUTER}`)
      expect(result.output).toContain("computer test-computer")
      expect(mock.asked).toHaveLength(0)
      expect(mock.bodies).toHaveLength(0)
    }),
  )

  it.instance("refuses a find answered with another computer's observation and names both", () =>
    Effect.gen(function* () {
      resetMock()
      holdOtherComputerTree()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          result: {
            observation: { id: FOREIGN_OBSERVATION },
            matches: [
              {
                element: {
                  id: "atspi:9001",
                  role: "button",
                  name: "Quit",
                  actions: ["click"],
                  bounds: { x: 4, y: 6, width: 20, height: 10 },
                },
                reference: { elementId: "atspi:9001", observationId: FOREIGN_OBSERVATION },
                score: 0.91,
              },
            ],
          },
        })
      const foreign = yield* withEnv({ computerId: "test-computer" }, () => execFind({ query: "Quit" }))
      expect((foreign.metadata as { refused?: boolean }).refused).toBe(true)
      expect(foreign.output).toContain(`computer ${FOREIGN_COMPUTER}`)
      expect(foreign.output).toContain("computer test-computer")
      // The other computer's ref is never handed out as a target to act on.
      expect(foreign.output).not.toContain("atspi:9001")
      // This computer's own tree is still found.
      resetMock()
      mock.handler = (req) =>
        respond(req, {
          ok: true,
          result: {
            observation: { id: "obs-own-computer-find" },
            matches: [
              {
                element: {
                  id: "el-export",
                  role: "button",
                  name: "Export",
                  actions: ["click"],
                  bounds: { x: 270, y: 100, width: 60, height: 24 },
                },
                reference: { elementId: "el-export", observationId: "obs-own-computer-find" },
                score: 0.93,
              },
            ],
          },
        })
      const own = yield* withEnv({ computerId: "test-computer" }, () => execFind({ query: "Export" }))
      expect((own.metadata as { refused?: boolean }).refused).toBeUndefined()
      expect(own.metadata.matches).toBe(1)
      expect(own.output).toContain("el-export")
    }),
  )
})
