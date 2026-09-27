import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./browser.txt"
import { configFromEnv, computerId, request } from "./client"

export const Parameters = Schema.Struct({
  action: Schema.Literals([
    "status",
    "open",
    "navigate",
    "read",
    "find",
    "images",
    "save_image",
    "copy_image",
    "click",
    "type",
    "key",
    "tabs",
    "activate_tab",
    "close_tab",
    "back",
    "forward",
    "reload",
  ]).annotate({ description: "The browser operation to perform." }),
  url: Schema.optional(Schema.String).annotate({ description: "URL for open and navigate." }),
  query: Schema.optional(Schema.String).annotate({ description: "What to find on the page, for example 'Search suppliers'." }),
  role: Schema.optional(Schema.String).annotate({ description: "Optional role filter for find, for example button or textbox." }),
  target: Schema.optional(Schema.String).annotate({
    description: "Page element id from browser_find, or image id from the images action.",
  }),
  text: Schema.optional(Schema.String).annotate({ description: "Text for type." }),
  key: Schema.optional(Schema.String).annotate({ description: "Key for key, for example Enter or Tab." }),
  tab: Schema.optional(Schema.String).annotate({ description: "Tab id from tabs." }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum candidates for find, or characters to return for read. Defaults to 8 for find.",
  }),
  offset: Schema.optional(Schema.Number).annotate({
    description: "Starting character offset for read. Use the offset from a previous truncated read to continue.",
  }),
  path: Schema.optional(Schema.String).annotate({
    description:
      "Absolute file path for save_image. Defaults to ~/Downloads/omnia with a name taken from the image URL or alt text.",
  }),
  name: Schema.optional(Schema.String).annotate({ description: "File name for save_image when no path is given." }),
  x: Schema.optional(Schema.Number).annotate({
    description: "Viewport pixel x for click when no element id is available. Use coordinates from browser_find.",
  }),
  y: Schema.optional(Schema.Number).annotate({ description: "Viewport pixel y for click." }),
})

type BrowserResponse = {
  ok: boolean
  result: {
    success: boolean
    message?: string
    verification?: { status?: string; message?: string }
    metadata?: {
      url?: string
      title?: string
      text?: string
      length?: number
      hash?: string
      offset?: number
      totalLength?: number
      truncated?: boolean
      candidates?: Array<{
        id: string
        role: string
        name: string
        score?: number
        visible?: boolean
        disabled?: boolean
        rect?: { x: number; y: number; width: number; height: number }
        center?: { x: number; y: number }
      }>
      clicked?: { name?: string; role?: string; id?: string; x?: number; y?: number; rect?: { x: number; y: number; width: number; height: number } }
      tabs?: Array<{ id: string; url: string; title?: string }>
      images?: Array<{
        id: string
        src: string
        alt?: string
        width: number
        height: number
        naturalWidth: number
        naturalHeight: number
        visible: boolean
        rect?: { x: number; y: number; width: number; height: number }
        link?: string
      }>
      path?: string
      bytes?: number
      mimeType?: string
      src?: string
      alt?: string
      method?: string
      tab?: string | { id: string; url: string }
      value?: string
      status?: { running: boolean; browser?: string; tabs: number }
    }
    error?: { code?: string; message: string }
  }
}

export const ComputerBrowserTool = Tool.define<typeof Parameters, Record<string, unknown>, HttpClient.HttpClient>(
  "computer_browser",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const config = yield* configFromEnv()
          if ((params.action === "navigate" || params.action === "open") && !params.url) {
            throw new Error(`The ${params.action} action requires url.`)
          }
          if (params.action === "find" && !params.query) {
            throw new Error("The find action requires query.")
          }
          if (params.action === "click" && !params.query && !params.target && (params.x === undefined || params.y === undefined)) {
            throw new Error("The click action requires target, query, or x/y coordinates.")
          }
          if (params.action === "type" && (!params.target || params.text === undefined)) {
            throw new Error("The type action requires target and text.")
          }
          if (
            (params.action === "save_image" || params.action === "copy_image") &&
            !params.target &&
            !params.query &&
            !params.url
          ) {
            throw new Error(
              "The " + params.action + " action requires an image id from the images action, a query, or a url.",
            )
          }
          yield* ctx.ask({
            permission: "computer",
            patterns: [`browser:${params.action}:${params.query ?? params.url ?? params.target ?? "page"}`],
            always: ["*"],
            metadata: { operation: "browser", action: params.action, url: params.url, query: params.query },
          })
          const id = yield* computerId(http, config)
          const result = yield* request<BrowserResponse>(http, config, "POST", `/v1/computers/${id}/actions`, {
            action: `browser_${params.action}`,
            ...(params.url === undefined ? {} : { url: params.url }),
            ...(params.query === undefined ? {} : { query: params.query }),
            ...(params.role === undefined ? {} : { role: params.role }),
            ...(params.target === undefined ? {} : { target: { elementId: params.target } }),
            ...(params.text === undefined ? {} : { text: params.text }),
            ...(params.key === undefined ? {} : { key: params.key }),
            ...(params.tab === undefined ? {} : { tab: params.tab }),
            ...(params.limit === undefined ? {} : { limit: params.limit }),
            ...(params.offset === undefined ? {} : { offset: params.offset }),
            ...(params.x === undefined ? {} : { x: params.x }),
            ...(params.y === undefined ? {} : { y: params.y }),
            ...(params.path === undefined ? {} : { path: params.path }),
            ...(params.name === undefined ? {} : { name: params.name }),
            approve: true,
            approvedBy: `session:${ctx.sessionID}`,
            approvedScopes: ["BROWSER"],
            sessionId: ctx.sessionID,
          })
          const outcome = result.result
          const metadata = outcome.metadata ?? {}
          if (!outcome.success) {
            const title = `Browser ${params.action} failed`
            yield* ctx.metadata({ title, metadata: {} })
            return {
              title,
              output: outcome.error?.message ?? outcome.message ?? "The browser action failed.",
              metadata: { success: false, error: outcome.error?.code },
            }
          }
          const title = browserTitle(params.action, metadata)
          yield* ctx.metadata({ title, metadata: {} })
          const lines: string[] = []
          if (outcome.message) lines.push(outcome.message)
          if (metadata.candidates && metadata.candidates.length > 0) {
            for (const candidate of metadata.candidates) {
              const at =
                candidate.center === undefined
                  ? candidate.rect === undefined
                    ? ""
                    : ` at pixel ${candidate.rect.x + Math.round(candidate.rect.width / 2)},${candidate.rect.y + Math.round(candidate.rect.height / 2)}`
                  : ` at pixel ${candidate.center.x},${candidate.center.y}`
              const size =
                candidate.rect === undefined ? "" : ` size ${candidate.rect.width}x${candidate.rect.height}`
              lines.push(
                `- ${candidate.role} "${candidate.name}" id=${candidate.id}${at}${size}${candidate.score === undefined ? "" : ` confidence=${candidate.score.toFixed(2)}`}${candidate.visible === false ? " (not visible)" : ""}${candidate.disabled === true ? " (disabled)" : ""}`,
              )
            }
          }
          if (metadata.tabs && metadata.tabs.length > 0) {
            for (const tab of metadata.tabs) lines.push(`- ${tab.title ?? tab.url} (tab ${tab.id})`)
          }
          if (metadata.images && metadata.images.length > 0) {
            for (const image of metadata.images) {
              const label = image.alt === undefined || image.alt.length === 0 ? "" : ` "${image.alt}"`
              const size = `${image.naturalWidth || image.width}x${image.naturalHeight || image.height}`
              lines.push(
                `- id=${image.id} ${size}${label}${image.visible ? "" : " (not visible)"} ${image.src}${image.link === undefined ? "" : ` -> ${image.link}`}`,
              )
            }
          }
          if (metadata.path !== undefined && metadata.bytes !== undefined) {
            lines.push(`saved to ${metadata.path} (${metadata.bytes} bytes${metadata.mimeType === undefined ? "" : `, ${metadata.mimeType}`})`)
            if (metadata.src !== undefined) lines.push(`source: ${metadata.src}`)
          }
          if (metadata.clicked !== undefined && metadata.clicked.x !== undefined) {
            lines.push(`clicked at viewport pixel ${metadata.clicked.x},${metadata.clicked.y}`)
          }
          if (typeof metadata.tab === "string") lines.push(`tab=${metadata.tab}`)
          else if (metadata.tab !== undefined) lines.push(`tab=${metadata.tab.id} ${metadata.tab.url}`)
          if (metadata.text !== undefined) {
            lines.push(metadata.text)
            lines.push(`[url=${metadata.url ?? ""} length=${metadata.length ?? metadata.text.length} hash=${metadata.hash ?? ""}]`)
          }
          if (metadata.offset !== undefined || metadata.totalLength !== undefined || metadata.truncated !== undefined) {
            lines.push(
              `[offset=${metadata.offset ?? 0} total=${metadata.totalLength ?? metadata.length ?? 0} truncated=${metadata.truncated ?? false}]`,
            )
          }
          if (outcome.verification?.message) lines.push(`verification: ${outcome.verification.status} — ${outcome.verification.message}`)
          return {
            title,
            output: lines.join("\n"),
            metadata: {
              success: true,
              action: params.action,
              url: metadata.url,
              tab: metadata.tab,
              length: metadata.length,
              hash: metadata.hash,
              verification: outcome.verification?.status,
            },
          }
        }),
    }
  }),
)

function browserTitle(action: string, metadata: NonNullable<BrowserResponse["result"]["metadata"]>): string {
  if (action === "read") return `Read page: ${metadata.title ?? metadata.url ?? "page"}`
  if (action === "find") return `Found ${metadata.candidates?.length ?? 0} page element(s)`
  if (action === "tabs") return `${metadata.tabs?.length ?? 0} browser tab(s)`
  if (action === "images") return `Found ${metadata.images?.length ?? 0} page image(s)`
  if (action === "save_image") return `Saved image${metadata.path === undefined ? "" : `: ${metadata.path}`}`
  if (action === "copy_image") return "Copied image to clipboard"
  if (action === "status") return metadata.status?.running === true ? `Browser running (${metadata.status.browser ?? "unknown"})` : "Browser not running"
  if (action === "open" || action === "navigate") {
    const target = typeof metadata.tab === "string" ? metadata.url : (metadata.tab?.url ?? metadata.url)
    return `Browser ${action}: ${target ?? ""}`
  }
  return `Browser ${action}`
}
