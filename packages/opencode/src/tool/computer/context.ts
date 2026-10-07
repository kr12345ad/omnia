import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./context.txt"
import { ActionEnvelope, configFromEnv, computerId, request } from "./client"
import { renderFailure } from "./output"
import { scopesForAction } from "./policy"

export const Parameters = Schema.Struct({})

type ContextResponse = {
  ok: boolean
  result: {
    success: boolean
    message?: string
    metadata?: {
      platform?: string
      pointer?: { x: number; y: number; held: boolean }
      activeWindow?: { role?: string; name?: string; application?: string }
      focused?: { role?: string; name?: string; text?: string; id?: string; center?: { x: number; y: number } }
      windows?: Array<{ name: string; application?: string }>
      browser?: { running: boolean; tabs: number; name?: string; currentTab?: string }
    }
    error?: { code?: string; message: string }
  }
}

export const ComputerContextTool = Tool.define<typeof Parameters, Record<string, unknown>, HttpClient.HttpClient>(
  "computer_context",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params, ctx) =>
        Effect.gen(function* () {
          const config = yield* configFromEnv()
          const id = yield* computerId(http, config, ctx.sessionID)
          const result = yield* request<ContextResponse>(
            http,
            config,
            "POST",
            `/v1/computers/${id}/actions`,
            {
              action: "get_context",
              approve: true,
              approvedBy: `session:${ctx.sessionID}`,
              // get_context needs UI_READ, POINTER, and BROWSER together; the
              // pointer position and the browser status come with the tree.
              approvedScopes: scopesForAction("get_context"),
              sessionId: ctx.sessionID,
            },
            { validate: Schema.is(ActionEnvelope) },
          )
          const outcome = result.result
          if (!outcome.success) {
            const title = "Context unavailable"
            yield* ctx.metadata({ title, metadata: {} })
            return {
              title,
              output: renderFailure(outcome.error, outcome.message ?? "The runtime could not report its context."),
              metadata: { success: false, error: outcome.error?.code },
            }
          }
          const metadata = outcome.metadata ?? {}
          const window = metadata.activeWindow
          const title = window?.name === undefined ? "Computer context" : `At ${window.name}`
          yield* ctx.metadata({ title, metadata: {} })
          const lines: string[] = []
          if (window !== undefined) {
            lines.push(
              `active window: ${window.name ?? "unknown"}${window.application === undefined ? "" : ` (${window.application})`}`,
            )
          }
          if (metadata.focused !== undefined) {
            const focused = metadata.focused
            const label = focused.name ?? focused.text ?? focused.id ?? ""
            const center = focused.center === undefined ? "" : ` at ${focused.center.x},${focused.center.y}`
            lines.push(`focus: ${focused.role ?? "element"} "${label}"${center}`)
          } else {
            lines.push("focus: none reported")
          }
          if (metadata.pointer !== undefined) {
            lines.push(
              `pointer: ${metadata.pointer.x},${metadata.pointer.y}${metadata.pointer.held ? " (button held)" : ""}`,
            )
          }
          if (metadata.browser !== undefined) {
            const browser = metadata.browser
            lines.push(
              `browser: ${browser.running ? `running (${browser.name ?? "unknown"})` : "not running"}, ${browser.tabs} tab(s)${browser.currentTab === undefined ? "" : `, current tab ${browser.currentTab}`}`,
            )
          }
          if (metadata.windows !== undefined && metadata.windows.length > 0) {
            const names = metadata.windows.slice(0, 20).map((entry) => entry.name)
            if (metadata.windows.length > 20) names.push(`… and ${metadata.windows.length - 20} more`)
            lines.push(`open windows: ${names.join(", ")}`)
          }
          if (metadata.platform !== undefined) lines.push(`platform: ${metadata.platform}`)
          return {
            title,
            output: lines.join("\n"),
            metadata: { success: true, ...metadata },
          }
        }),
    }
  }),
)
