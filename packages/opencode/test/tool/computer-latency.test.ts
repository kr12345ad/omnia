import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import type { HttpClientRequest } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { MessageID, SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { ComputerSnapshotTool, Parameters as SnapshotParameters } from "@/tool/computer/snapshot"
import { CAPS } from "@/tool/computer/output"

type Element = {
  id: string
  role: string
  name: string
  text?: string
  value?: string
  description?: string
  states?: string[]
  actions?: string[]
  bounds: { x: number; y: number; width: number; height: number }
  metadata: { application: string }
}

interface MockState {
  handler: (req: HttpClientRequest.HttpClientRequest) => Effect.Effect<HttpClientResponse.HttpClientResponse>
  observeRequests: number
}

const mock: MockState = {
  handler: () => Effect.die(new Error("unhandled mock request")),
  observeRequests: 0,
}

const mockClient = HttpClient.make((req) => {
  mock.observeRequests++
  return mock.handler(req)
})

const testLayer = LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node]), [
  [httpClient, Layer.succeed(HttpClient.HttpClient, mockClient)],
])

const it = testEffect(testLayer)

const decodeSnapshot = Schema.decodeUnknownSync(SnapshotParameters)

/** A desktop with two windows and realistically wordy controls. */
function desktop(count: number): Element[] {
  return [
    {
      id: "win-shell",
      role: "window",
      name: "Shell",
      states: ["focused"],
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      metadata: { application: "shell" },
    },
    {
      id: "win-editor",
      role: "window",
      name: "Quick hello — editor",
      states: [],
      bounds: { x: 40, y: 60, width: 1200, height: 800 },
      metadata: { application: "code" },
    },
    ...Array.from({ length: count }, (_, index): Element => {
      const role = index % 4 === 0 ? "button" : index % 4 === 1 ? "textfield" : index % 4 === 2 ? "checkbox" : "label"
      return {
        id: `atspi:${index}`,
        role,
        name: `Control ${index}`,
        text: `row ${Math.floor(index / 20)} of the synthetic desktop`,
        ...(role === "textfield" ? { value: `typed value ${index}` } : {}),
        description: `control number ${index} of the synthetic desktop`,
        states: ["enabled"],
        actions: role === "label" ? [] : ["focus", "click"],
        bounds: { x: 10 + (index % 20) * 60, y: 60 + Math.floor(index / 20) * 32, width: 120, height: 24 },
        metadata: { application: "code" },
      }
    }),
  ]
}

/** Three realistic per-step edits: a rename, a state change, and a move. */
function withThreeChanges(elements: Element[]): Element[] {
  const moved = elements.map((element) =>
    element.id === "atspi:7"
      ? {
          ...element,
          bounds: {
            x: element.bounds.x + 24,
            y: element.bounds.y,
            width: element.bounds.width,
            height: element.bounds.height,
          },
        }
      : element,
  )
  return moved.map((element) => {
    if (element.id === "atspi:3") return { ...element, name: `Control 3 (edited)` }
    if (element.id === "atspi:11") return { ...element, states: ["enabled", "focused"] }
    return element
  })
}

function withEveryControlChanged(elements: Element[]): Element[] {
  return elements.map((element) =>
    element.role === "window" ? element : { ...element, text: `${element.text ?? ""} ${"x".repeat(3000)}` },
  )
}

function respond(req: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) {
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      req,
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    ),
  )
}

function serve(...trees: Element[][]) {
  const queue = [...trees]
  mock.handler = (req) =>
    respond(req, {
      ok: true,
      observation: { id: `obs-${mock.observeRequests}`, elements: queue.shift() ?? [] },
    })
}

function makeCtx(): Tool.Context {
  return {
    sessionID: SessionID.make("ses_latency"),
    messageID: MessageID.make("msg_latency"),
    callID: "",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata() {
      return Effect.void
    },
    ask() {
      return Effect.void
    },
  }
}

const execSnapshot = Effect.fn("test.execSnapshotLatency")(function* (
  args: Schema.Schema.Type<typeof SnapshotParameters>,
) {
  const info = yield* ComputerSnapshotTool
  const tool = yield* info.init()
  return yield* tool.execute(args, makeCtx())
})

function withEnv<A, E, R>(computerId: string, fn: () => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = {
        url: process.env.OMNIA_SERVER_URL,
        token: process.env.OMNIA_SERVER_TOKEN,
        computer: process.env.OMNIA_COMPUTER_ID,
      }
      process.env.OMNIA_SERVER_URL = "http://127.0.0.1:9"
      process.env.OMNIA_SERVER_TOKEN = "test-token"
      process.env.OMNIA_COMPUTER_ID = computerId
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

type Payload = {
  observationId?: string
  application?: string
  generation?: number
  mode?: string
  source?: string
  sinceGeneration?: number
  unchangedCount?: number
  totalElements?: number
  returnedElements?: number
  truncated?: boolean
  windows?: Array<{ ref?: string; change?: string; role?: string }>
  elements?: Array<{ ref?: string; change?: string; name?: string; states?: string[] }>
  warnings?: string[]
}

function payloadOf(result: { output: string }): { payload: Payload; chars: number } {
  const text = result.output.split("\n…")[0]
  return { payload: JSON.parse(text) as Payload, chars: text.length }
}

describe("computer snapshot parameters", () => {
  test("accepts mode and sinceGeneration", () => {
    expect(decodeSnapshot({ mode: "diff", sinceGeneration: 4 })).toEqual({ mode: "diff", sinceGeneration: 4 })
    expect(decodeSnapshot({})).toEqual({})
    expect(decodeSnapshot({ mode: "full" })).toEqual({ mode: "full" })
  })

  test("rejects an unknown mode and a negative generation", () => {
    expect(() => decodeSnapshot({ mode: "summary" })).toThrow()
    expect(() => decodeSnapshot({ sinceGeneration: -1 })).toThrow()
  })
})

describe("computer snapshot diff mode", () => {
  it.effect("returns only what changed and stays smaller than a full snapshot", () =>
    Effect.gen(function* () {
      mock.observeRequests = 0
      const first = desktop(CAPS.snapshotElements)
      serve(first, withThreeChanges(first))
      const full = yield* withEnv("latency-diff-host", () => execSnapshot({ app: "code" }))
      const fullRead = payloadOf(full)
      expect(fullRead.payload.mode).toBe("full")
      expect(fullRead.payload.source).toBe("observation")
      expect(fullRead.payload.generation).toBeGreaterThan(0)
      expect(fullRead.payload.returnedElements).toBe(CAPS.snapshotElements)
      const held = fullRead.payload.generation ?? 0

      const before = mock.observeRequests
      const diff = yield* withEnv("latency-diff-host", () =>
        execSnapshot({ app: "code", mode: "diff", sinceGeneration: held }),
      )
      const diffRead = payloadOf(diff)
      expect(mock.observeRequests).toBe(before + 1)
      expect(diffRead.payload.mode).toBe("diff")
      expect(diffRead.payload.source).toBe("observation")
      expect(diffRead.payload.generation).toBeGreaterThan(held)
      expect(diffRead.payload.sinceGeneration).toBe(held)
      expect(diffRead.payload.unchangedCount).toBe(CAPS.snapshotElements - 3)
      expect(diffRead.payload.totalElements).toBe(CAPS.snapshotElements)
      expect(diffRead.payload.elements?.map((element) => element.ref)).toEqual(["atspi:3", "atspi:7", "atspi:11"])
      expect(diffRead.payload.elements?.map((element) => element.change)).toEqual([
        "state-changed",
        "moved",
        "state-changed",
      ])
      expect(diffRead.payload.elements?.[0]).toMatchObject({ name: "Control 3 (edited)" })
      expect(diffRead.payload.elements?.[2]).toMatchObject({ states: ["enabled", "focused"] })
      expect(diffRead.payload.windows).toEqual([])
      expect(diffRead.payload.truncated).toBe(false)
      expect(diffRead.chars).toBeLessThan(fullRead.chars)
      console.log(
        `computer_snapshot on 200 controls: full=${fullRead.chars} chars, diff=${diffRead.chars} chars ` +
          `(${Math.round((1 - diffRead.chars / fullRead.chars) * 100)}% smaller)`,
      )
    }),
  )

  it.effect("labels every change kind the omnia projection produces", () =>
    Effect.gen(function* () {
      mock.observeRequests = 0
      const first = desktop(12)
      const template = first[2]
      const added: Element = { ...template, id: "atspi:99", name: "Control 99", bounds: { ...template.bounds, x: 610 } }
      const current: Element[] = [
        first[0],
        { ...first[1], name: "Quick hello — editor (edited)" },
        ...first
          .slice(2)
          .filter((element) => element.id !== "atspi:2")
          .map((element) => {
            if (element.id === "atspi:3") return { ...element, name: "Control 3 (edited)" }
            if (element.id === "atspi:7") return { ...element, bounds: { ...element.bounds, x: element.bounds.x + 24 } }
            if (element.id === "atspi:11") return { ...element, states: ["enabled", "focused"] }
            return element
          }),
        added,
      ]
      serve(first, current)
      const full = yield* withEnv("latency-label-host", () => execSnapshot({ app: "code" }))
      const held = payloadOf(full).payload.generation ?? 0
      const diff = yield* withEnv("latency-label-host", () =>
        execSnapshot({ app: "code", mode: "diff", sinceGeneration: held }),
      )
      const read = payloadOf(diff)
      expect(read.payload.mode).toBe("diff")
      expect(read.payload.totalElements).toBe(12)
      expect(read.payload.elements?.map((element) => [element.change, element.ref])).toEqual([
        ["state-changed", "atspi:3"],
        ["moved", "atspi:7"],
        ["state-changed", "atspi:11"],
        ["added", "atspi:99"],
        ["removed", "atspi:2"],
      ])
      expect(read.payload.windows?.map((window) => [window.change, window.ref])).toEqual([
        ["state-changed", "win-editor"],
      ])
      // The unchanged count spans the whole tree, not the page the tool returned.
      expect(read.payload.unchangedCount).toBe(8)
      expect(read.payload.truncated).toBe(false)
    }),
  )

  it.effect("falls back to a full snapshot when the diff is larger than a full snapshot", () =>
    Effect.gen(function* () {
      mock.observeRequests = 0
      const first = desktop(CAPS.snapshotElements)
      serve(first, withEveryControlChanged(first))
      const full = yield* withEnv("latency-cap-host", () => execSnapshot({ app: "code" }))
      const held = payloadOf(full).payload.generation ?? 0
      const diff = yield* withEnv("latency-cap-host", () =>
        execSnapshot({ app: "code", mode: "diff", sinceGeneration: held }),
      )
      const read = payloadOf(diff)
      expect(read.payload.mode).toBe("full")
      expect(read.payload.sinceGeneration).toBe(held)
      expect(read.payload.unchangedCount).toBeUndefined()
      expect(read.payload.warnings?.[0]).toContain("the diff was larger than a full snapshot")
      expect(read.chars).toBeLessThanOrEqual(CAPS.snapshotChars)
      expect(read.payload.elements?.length).toBeGreaterThan(0)
      console.log(`computer_snapshot diff over the char cap: full fallback payload=${read.chars} chars`)
    }),
  )

  it.effect("serves a re-read of a held generation from the session cache", () =>
    Effect.gen(function* () {
      mock.observeRequests = 0
      serve(desktop(CAPS.snapshotElements), withThreeChanges(desktop(CAPS.snapshotElements)))
      const full = yield* withEnv("latency-cache-host", () => execSnapshot({ app: "code" }))
      const held = payloadOf(full).payload.generation ?? 0
      const diff = yield* withEnv("latency-cache-host", () =>
        execSnapshot({ app: "code", mode: "diff", sinceGeneration: held }),
      )
      const head = payloadOf(diff).payload.generation ?? 0
      const before = mock.observeRequests

      const again = yield* withEnv("latency-cache-host", () => execSnapshot({ app: "code", sinceGeneration: head }))
      const reread = payloadOf(again)
      expect(mock.observeRequests).toBe(before)
      expect(reread.payload.source).toBe("cache")
      expect(reread.payload.generation).toBe(head)
      expect(reread.payload.sinceGeneration).toBe(head)
      expect(reread.payload.returnedElements).toBe(CAPS.snapshotElements)

      const second = yield* withEnv("latency-cache-host", () =>
        execSnapshot({ app: "code", sinceGeneration: head, limit: 5, offset: 5 }),
      )
      const paged = payloadOf(second)
      expect(mock.observeRequests).toBe(before)
      expect(paged.payload.returnedElements).toBe(5)
      expect(paged.payload.elements?.map((element) => element.ref)).toEqual([
        "atspi:5",
        "atspi:6",
        "atspi:7",
        "atspi:8",
        "atspi:9",
      ])
      expect(paged.payload.truncated).toBe(true)
      console.log(`computer_snapshot re-read of generation ${head}: 0 requests, ${reread.chars} chars from cache`)
    }),
  )

  it.effect("refuses a baseline the session no longer holds instead of rebinding it", () =>
    Effect.gen(function* () {
      mock.observeRequests = 0
      const first = desktop(3)
      serve(first, first)
      const full = yield* withEnv("latency-stale-host", () => execSnapshot({ app: "code" }))
      const held = payloadOf(full).payload.generation ?? 0
      const diff = yield* withEnv("latency-stale-host", () =>
        execSnapshot({ app: "code", mode: "diff", sinceGeneration: held + 50 }),
      )
      const read = payloadOf(diff)
      expect(read.payload.mode).toBe("full")
      expect(read.payload.warnings?.join(" ")).toContain(`generation ${held + 50} is not held`)
      expect(read.payload.elements).toHaveLength(3)
    }),
  )

  it.effect("pages a diff instead of dropping the tail", () =>
    Effect.gen(function* () {
      mock.observeRequests = 0
      const first = desktop(12)
      const edited = first.map((element) =>
        element.role === "window" ? element : { ...element, name: `${element.name} !` },
      )
      serve(first, edited, edited)
      const full = yield* withEnv("latency-page-host", () => execSnapshot({ app: "code" }))
      const held = payloadOf(full).payload.generation ?? 0
      const pageOne = yield* withEnv("latency-page-host", () =>
        execSnapshot({ app: "code", mode: "diff", sinceGeneration: held, limit: 5 }),
      )
      const page = payloadOf(pageOne)
      expect(page.payload.returnedElements).toBe(5)
      expect(page.payload.truncated).toBe(true)
      expect(page.payload.unchangedCount).toBe(0)
      const pageTwo = yield* withEnv("latency-page-host", () =>
        execSnapshot({ app: "code", mode: "diff", sinceGeneration: held, limit: 5, offset: 5 }),
      )
      const rest = payloadOf(pageTwo)
      expect(rest.payload.returnedElements).toBe(5)
      expect(rest.payload.unchangedCount).toBe(0)
      expect(rest.payload.elements?.map((element) => element.ref)).toEqual([
        "atspi:5",
        "atspi:6",
        "atspi:7",
        "atspi:8",
        "atspi:9",
      ])
    }),
  )
})
