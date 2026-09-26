import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./act.txt"
import { configFromEnv, computerId, request } from "./client"

export const ACTIONS = [
  "click",
  "double_click",
  "right_click",
  "middle_click",
  "hover",
  "mouse_down",
  "mouse_up",
  "type",
  "key",
  "hotkey",
  "focus",
  "focus_window",
  "scroll",
  "move",
  "drag",
  "copy",
  "paste",
  "paste_table",
  "wait",
  "release_keys",
  "read_text",
  "get_focus",
  "get_cursor",
  "read_clipboard",
  "write_clipboard",
  "dismiss",
  "menu",
  "launch_app",
  "activate_app",
  "close_app",
  "open_file",
  "open_url",
] as const

const Endpoint = Schema.Struct({
  elementId: Schema.optional(Schema.String),
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
}).annotate({ description: "A drag endpoint: either an element ID or explicit x,y coordinates." })

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description: "The interface action to perform.",
  }),
  target: Schema.optional(Schema.String).annotate({
    description:
      "Stable element ID from computer_find or computer_observe, for example atspi:3.5. One of target or query is required for click, double_click, right_click, middle_click, type, focus, move, and scroll-on-element; pointer actions also accept x/y coordinates.",
  }),
  query: Schema.optional(Schema.String).annotate({
    description:
      "Control to act on by meaning, for example 'Export button'. The runtime resolves it server-side and rejects ambiguous matches instead of guessing.",
  }),
  role: Schema.optional(Schema.String).annotate({ description: "Optional role filter for query, for example button." }),
  window: Schema.optional(Schema.String).annotate({
    description:
      "Window title fragment. For focus_window it selects the window; for type, key, hotkey, and paste it focuses that window first.",
  }),
  observationId: Schema.optional(Schema.String).annotate({
    description: "Observation the target came from, for staleness checking. Defaults to re-observing.",
  }),
  text: Schema.optional(Schema.String).annotate({ description: "Text for the type action." }),
  start: Schema.optional(Schema.String).annotate({
    description: "Optional marker for type: skip everything before it. The runtime refuses to type if it is absent.",
  }),
  stop: Schema.optional(Schema.String).annotate({
    description: "Optional marker for type: stop immediately after it. The runtime refuses to type if it is absent.",
  }),
  endKey: Schema.optional(Schema.String).annotate({
    description: "Optional key pressed after typing finishes, for example Return.",
  }),
  key: Schema.optional(Schema.String).annotate({
    description: "Key for the key action: a character or Return, Tab, Escape, BackSpace, Delete, arrows, F1-F12.",
  }),
  keys: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Key combination for hotkey, for example ['ctrl','shift','t'].",
  }),
  app: Schema.optional(Schema.String).annotate({
    description: "Application name or command for launch_app, activate_app, and close_app.",
  }),
  url: Schema.optional(Schema.String).annotate({ description: "URL for open_url." }),
  path: Schema.optional(Schema.String).annotate({ description: "Filesystem path for open_file." }),
  direction: Schema.optional(Schema.Literals(["up", "down", "left", "right"])).annotate({
    description: "Scroll direction for the scroll action.",
  }),
  amount: Schema.optional(Schema.Number).annotate({
    description:
      "Scroll steps, wait milliseconds, hover hold milliseconds, or pointer travel milliseconds for click/move/drag. Defaults depend on the action.",
  }),
  button: Schema.optional(Schema.Literals(["left", "middle", "right"])).annotate({
    description: "Mouse button for mouse_down and mouse_up. Defaults to left.",
  }),
  rows: Schema.optional(Schema.Array(Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])))).annotate({
    description: "2D array for paste_table; fills the target range in one paste.",
  }),
  x: Schema.optional(Schema.Number).annotate({
    description: "Screen x coordinate for pointer actions when no element target is available.",
  }),
  y: Schema.optional(Schema.Number).annotate({ description: "Screen y coordinate for pointer actions." }),
  from: Schema.optional(Endpoint).annotate({ description: "Start of a drag action." }),
  to: Schema.optional(Endpoint).annotate({ description: "End of a drag action, for example an image resize handle." }),
})

type ActResponse = {
  ok: true
  result: {
    success: boolean
    status?: string
    message?: string
    observation?: { id: string; text?: string; metadata?: Record<string, unknown> }
    verification?: { status?: string; message?: string }
    metadata?: {
      target?: { role?: string; name?: string }
      stateDelta?: { summary?: string; hasChanges?: boolean; highlights?: readonly string[] }
      context?: readonly string[]
    }
    error?: { code?: string; message: string }
  }
}

const ACTION_LABEL: Record<string, string> = {
  click: "Clicked",
  double_click: "Double-clicked",
  right_click: "Right-clicked",
  type: "Typed into",
  key: "Pressed key",
  hotkey: "Sent shortcut",
  focus: "Focused",
  focus_window: "Focused window",
  scroll: "Scrolled",
  move: "Moved pointer",
  launch_app: "Launched",
  activate_app: "Activated",
  close_app: "Closed",
  open_file: "Opened",
  open_url: "Opened",
  drag: "Dragged",
  copy: "Copied",
  paste: "Pasted",
  paste_table: "Pasted table",
  wait: "Waited",
  read_text: "Read text",
  get_focus: "Checked focus",
  release_keys: "Released keys",
  read_clipboard: "Read clipboard",
  write_clipboard: "Wrote clipboard",
  dismiss: "Dismissed",
  middle_click: "Middle-clicked",
  hover: "Hovered",
  mouse_down: "Held mouse button",
  mouse_up: "Released mouse button",
  get_cursor: "Read pointer position",
  menu: "Selected menu",
}

export const ComputerActTool = Tool.define<typeof Parameters, Record<string, unknown>, HttpClient.HttpClient>(
  "computer_act",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const config = yield* configFromEnv()
          if (params.action === "type" && !params.text) throw new Error("The type action requires text.")
          if (params.action === "key" && !params.key) throw new Error("The key action requires key.")
          if (params.action === "hotkey" && (!params.keys || params.keys.length === 0))
            throw new Error("The hotkey action requires keys.")
          if ((params.action === "launch_app" || params.action === "activate_app" || params.action === "close_app") && !params.app)
            throw new Error(`The ${params.action} action requires app.`)
          if (params.action === "open_url" && !params.url) throw new Error("The open_url action requires url.")
          if (params.action === "open_file" && !params.path) throw new Error("The open_file action requires path.")
          if (["type", "focus"].includes(params.action) && !params.target && !params.query) {
            throw new Error(`The ${params.action} action requires target or query.`)
          }
          const pointerAction = ["click", "double_click", "right_click", "middle_click", "move"].includes(params.action)
          if (pointerAction && !params.target && !params.query && (params.x === undefined || params.y === undefined)) {
            throw new Error(`The ${params.action} action requires target, query, or x/y coordinates.`)
          }
          yield* ctx.ask({
            permission: "computer",
            patterns: [
              `act:${params.action}:${params.target ?? params.query ?? params.app ?? params.url ?? params.path ?? "desktop"}`,
            ],
            always: ["*"],
            metadata: {
              operation: "act",
              action: params.action,
              ...(params.target === undefined ? {} : { target: params.target }),
              ...(params.query === undefined ? {} : { query: params.query }),
              ...(params.app === undefined ? {} : { app: params.app }),
              ...(params.text === undefined ? {} : { text: params.text }),
              ...(params.key === undefined ? {} : { key: params.key }),
            },
          })
          const id = yield* computerId(http, config)
          const result = yield* request<ActResponse>(http, config, "POST", `/v1/computers/${id}/actions`, {
            action: params.action,
            ...(params.target === undefined
              ? {}
              : {
                  target: {
                    elementId: params.target,
                    ...(params.observationId === undefined ? {} : { observationId: params.observationId }),
                  },
                }),
            ...(params.query === undefined ? {} : { query: params.query }),
            ...(params.role === undefined ? {} : { role: params.role }),
            ...(params.window === undefined ? {} : { window: params.window }),
            ...(params.text === undefined ? {} : { text: params.text }),
            ...(params.start === undefined ? {} : { start: params.start }),
            ...(params.stop === undefined ? {} : { stop: params.stop }),
            ...(params.endKey === undefined ? {} : { endKey: params.endKey }),
            ...(params.key === undefined ? {} : { key: params.key }),
            ...(params.keys === undefined ? {} : { keys: [...params.keys] }),
            ...(params.app === undefined ? {} : { app: params.app }),
            ...(params.url === undefined ? {} : { url: params.url }),
            ...(params.path === undefined ? {} : { path: params.path }),
            ...(params.direction === undefined ? {} : { direction: params.direction }),
            ...(params.amount === undefined ? {} : { amount: params.amount }),
            ...(params.button === undefined ? {} : { button: params.button }),
            ...(params.rows === undefined ? {} : { rows: params.rows }),
            ...(params.x === undefined ? {} : { x: params.x }),
            ...(params.y === undefined ? {} : { y: params.y }),
            ...(params.from === undefined ? {} : { from: params.from }),
            ...(params.to === undefined ? {} : { to: params.to }),
            approve: true,
            approvedBy: `session:${ctx.sessionID}`,
            approvedScopes: [
              "UI_READ",
              "UI_CONTROL",
              "KEYBOARD",
              "POINTER",
              "CLIPBOARD_READ",
              "CLIPBOARD_WRITE",
              "PROCESS_EXECUTE",
              "SCREEN_READ",
            ],
            sessionId: ctx.sessionID,
          })
          const outcome = result.result
          const targetName =
            typeof outcome.metadata?.target?.name === "string" && outcome.metadata.target.name.length > 0
              ? outcome.metadata.target.name
              : params.target ?? params.query ?? params.app ?? params.url ?? params.path ?? "desktop"
          const verification = outcome.verification?.status ?? (outcome.success ? "unverified" : "failed")
          const statusLabel = !outcome.success ? (outcome.error?.code ?? outcome.status ?? "failed") : verification
          const title = `${ACTION_LABEL[params.action] ?? params.action} ${targetName} (${statusLabel})`
          yield* ctx.metadata({ title, metadata: {} })
          const lines = [outcome.message ?? `${params.action} ${outcome.success ? "completed" : "did not complete"}.`]
          if (outcome.metadata?.stateDelta?.summary) lines.push(`observed change: ${outcome.metadata.stateDelta.summary}`)
          if (!outcome.success && Array.isArray(outcome.metadata?.context) && outcome.metadata.context.length > 0) {
            lines.push("current interface context:")
            for (const entry of outcome.metadata.context.slice(0, 12)) lines.push(`- ${entry}`)
          }
          if (outcome.verification?.message && outcome.verification.message !== outcome.metadata?.stateDelta?.summary) {
            lines.push(`verification: ${outcome.verification.message}`)
          }
          if (outcome.observation) {
            lines.push(
              `fresh observation ${outcome.observation.id}: re-read it with computer_observe or computer_find before the next action.`,
            )
          }
          if (outcome.error && !outcome.success) lines.push(`error: ${outcome.error.message}`)
          return {
            title,
            output: lines.join("\n"),
            metadata: {
              action: params.action,
              target: params.target,
              targetName,
              success: outcome.success,
              verification,
              observationId: outcome.observation?.id,
            },
          }
        }),
    }
  }),
)
