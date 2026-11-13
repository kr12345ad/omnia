import { plugin } from "bun"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { afterAll, describe, expect, mock, test } from "bun:test"
import { createComponent, isServer, render } from "solid-js/web"

// Bun has no Solid JSX transform, so the surface under test goes through the
// same esbuild + babel-preset-solid pipeline the app build uses.
const fromApp = createRequire(import.meta.url)
const fromVite = createRequire(realpathSync(fromApp.resolve("vite")))
const fromVitePluginSolid = createRequire(realpathSync(fromApp.resolve("vite-plugin-solid")))
const esbuild = fromVite("esbuild") as {
  transform(source: string, options: Record<string, unknown>): Promise<{ code: string }>
}
const babel = fromVitePluginSolid("@babel/core") as {
  transformAsync(source: string, options: Record<string, unknown>): Promise<{ code?: string } | null>
}
const solidPreset = fromVitePluginSolid("babel-preset-solid")

plugin({
  name: "chat-surface-solid-jsx-test",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }))
    build.onLoad({ filter: /\/app\/src\/chat\/app\.tsx$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      const stripped = await esbuild.transform(source, { loader: "tsx", jsx: "preserve" })
      const result = await babel.transformAsync(stripped.code, {
        filename: args.path,
        presets: [[solidPreset, { generate: "dom", hydratable: false }]],
        configFile: false,
        babelrc: false,
        sourceMaps: false,
      })
      return { contents: result?.code ?? stripped.code, loader: "js" }
    })
  },
})

// The transcript renderer is a large syntax-highlighting surface with its own
// worker; the chat page's state and request flow are what this suite covers.
mock.module("@opencode-ai/session-ui/markdown", () => ({
  Markdown: (props: { text?: string }) => {
    const text = document.createElement("div")
    text.setAttribute("data-slot", "markdown")
    text.textContent = props.text ?? ""
    return text
  },
}))

mock.module("@opencode-ai/ui/icon", () => ({
  Icon: (props: { name?: string }) => {
    const icon = document.createElement("span")
    icon.setAttribute("data-component", "icon")
    icon.setAttribute("aria-hidden", "true")
    if (props.name) icon.setAttribute("name", props.name)
    return icon
  },
}))

const { ChatApp } = isServer ? ({} as { ChatApp: never }) : await import("@/chat/app")

function settle(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let emit: ((event: unknown) => void) | undefined

function eventStream(signal?: AbortSignal) {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        emit = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        const timer = setTimeout(() => controller.close(), 5_000)
        signal?.addEventListener("abort", () => {
          clearTimeout(timer)
          controller.close()
        })
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

afterAll(() => {
  document.body.replaceChildren()
})

describe.skipIf(isServer)("chat surface", () => {
  test("mounts the chat-only page and sends a prompt to a tool-free session", async () => {
    const requests: { url: string; method: string; body?: string }[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined })

      if (url.endsWith("/api/location")) return Response.json({ directory: "/tmp/chat" })
      if (url.includes("/api/model")) {
        return Response.json({
          location: { directory: "/tmp/chat" },
          data: [
            {
              id: "test-model",
              providerID: "test-provider",
              name: "Test Model",
              api: { id: "test-model", type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://host/v1" },
            },
          ],
        })
      }
      if (url.includes("/api/session/active")) return Response.json({ data: {} })
      if (url.includes("/api/event")) return eventStream(init?.signal ?? undefined)
      if (url.includes("/api/session/") && url.includes("/message")) {
        return Response.json({
          data: [
            {
              id: "msg_1",
              type: "assistant",
              content: [{ type: "text", id: "part_1", text: "Hello back" }],
              time: { created: 2 },
            },
          ],
          cursor: { previous: null, next: null },
        })
      }
      if (method === "POST" && url.endsWith("/api/session")) {
        return Response.json({ data: { id: "ses_1", title: "", time: { created: 1, updated: 1 } } })
      }
      if (method === "POST" && url.endsWith("/prompt")) return Response.json({ data: {} })
      if (method === "POST" && url.endsWith("/model")) return new Response(null, { status: 204 })
      if (method === "PATCH" && url.endsWith("/session/ses_1")) {
        return Response.json({ id: "ses_1", title: "Hello" })
      }
      if (url.includes("/api/session")) return Response.json({ data: [] })
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const container = document.createElement("div")
    document.body.appendChild(container)
    const dispose = render(() => createComponent(ChatApp, { baseUrl: "https://host/test1" }), container)
    await settle(10)

    expect(container.textContent).toContain("What can I help with?")

    const input = container.querySelector("textarea")!
    input.value = "Hello"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await settle(20)

    const create = requests.find((entry) => entry.method === "POST" && entry.url.endsWith("/api/session"))
    expect(create?.url).toBe("https://host/test1/api/session")
    expect(JSON.parse(create?.body ?? "{}")).toMatchObject({
      agent: "chat",
      location: { directory: "/tmp/chat" },
    })
    expect(requests.some((entry) => entry.method === "POST" && entry.url.endsWith("/prompt"))).toBe(true)
    expect(requests.some((entry) => entry.url.includes("/api/event"))).toBe(true)
    const rename = requests.find((entry) => entry.method === "PATCH" && entry.url.endsWith("/session/ses_1"))
    expect(rename?.url).toBe("https://host/test1/session/ses_1")
    expect(JSON.parse(rename?.body ?? "{}")).toEqual({ title: "Hello" })

    emit?.({ type: "session.next.step.started", data: { sessionID: "ses_1", assistantMessageID: "msg_1" } })
    emit?.({
      type: "session.next.text.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", delta: "Hello back" },
    })
    await settle(10)
    expect(container.textContent).toContain("Hello back")
    expect(container.querySelector(".chat-send-stop")).not.toBeNull()

    // Session status uses busy/retry/idle, not the active snapshot's running.
    emit?.({ type: "session.status", data: { sessionID: "ses_1", status: { type: "idle" } } })
    await settle(10)
    expect(container.querySelector(".chat-send-stop")).toBeNull()

    emit?.({ type: "session.status", data: { sessionID: "ses_1", status: { type: "busy" } } })
    await settle(10)
    expect(container.querySelector(".chat-send-stop")).not.toBeNull()

    emit?.({ type: "session.next.step.ended", data: { sessionID: "ses_1", assistantMessageID: "msg_1" } })
    await settle(80)
    expect(container.querySelector(".chat-send-stop")).toBeNull()
    expect(container.textContent).toContain("Hello back")

    dispose()
    container.remove()
  })
})
