import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./act.txt"
import { ActionEnvelope, configFromEnv, computerId, request } from "./client"
import { UI_ACTIONS } from "./actions"
import {
  TILE_POSITIONS,
  actPermissionPattern,
  alwaysPatternsForAct,
  permissionText,
  scopesForAct,
  shortenCommand,
  validateAction,
} from "./policy"
import { CAPS, clip, renderFailure } from "./output"

export const ACTIONS = UI_ACTIONS

const Endpoint = Schema.Struct({
  elementId: Schema.optional(Schema.String),
  x: Schema.optional(Schema.Int),
  y: Schema.optional(Schema.Int),
}).annotate({ description: "A drag endpoint: either an element ID or explicit x,y coordinates." })

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description: "The interface action to perform.",
  }),
  target: Schema.optional(Schema.String).annotate({
    description:
      "Stable element ID from computer_find or computer_observe, for example atspi:3.5. One of target or query is required for click, double_click, right_click, middle_click, hover, type, focus, move, and scroll-on-element; pointer actions also accept x/y coordinates.",
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
  text: Schema.optional(Schema.String).annotate({ description: "Text for the type and set_value actions." }),
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
  url: Schema.optional(Schema.String).annotate({ description: "http:// or https:// URL for open_url." }),
  path: Schema.optional(Schema.String).annotate({ description: "Filesystem path for open_file." }),
  direction: Schema.optional(Schema.Literals(["up", "down", "left", "right"])).annotate({
    description: "Scroll direction for the scroll action.",
  }),
  amount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description:
      "Scroll steps, wait milliseconds, hover hold milliseconds, or pointer travel milliseconds for click/move/drag. Defaults depend on the action.",
  }),
  button: Schema.optional(Schema.Literals(["left", "middle", "right"])).annotate({
    description: "Mouse button for mouse_down and mouse_up. Defaults to left.",
  }),
  rows: Schema.optional(
    Schema.Array(Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]))),
  ).annotate({
    description: "2D array for paste_table; fills the target range in one paste.",
  }),
  x: Schema.optional(Schema.Int).annotate({
    description: "Screen x coordinate for pointer actions when no element target is available.",
  }),
  y: Schema.optional(Schema.Int).annotate({ description: "Screen y coordinate for pointer actions." }),
  from: Schema.optional(Endpoint).annotate({ description: "Start of a drag action." }),
  to: Schema.optional(Endpoint).annotate({ description: "End of a drag action, for example an image resize handle." }),
  position: Schema.optional(Schema.Literals(TILE_POSITIONS)).annotate({
    description: "Window position for window_tile.",
  }),
  point: Schema.optional(Schema.String).annotate({
    description: "Calibration point id returned by calibration_start, for calibration_measure.",
  }),
  command: Schema.optional(Schema.String).annotate({
    description:
      "Shell command for run_command, for example 'ls -la' or 'sudo systemctl restart nginx'. Runs on the connected computer and returns exit code, stdout, and stderr.",
  }),
  cwd: Schema.optional(Schema.String).annotate({ description: "Working directory for run_command." }),
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600000 }))).annotate({
    description: "Timeout in milliseconds for run_command. Defaults to 120000 and is capped at 600000.",
  }),
  credential: Schema.optional(Schema.String).annotate({
    description:
      "Credential selection for run_command and type: 'auto' uses a stored credential whose rules match, 'none' disables stored credentials, or a credential id or name. With a credential, type ignores text and enters the stored value instead. Stored credentials are managed in Settings > Computer > Computers; their secrets are never shown to the model.",
  }),
  field: Schema.optional(Schema.Literals(["username", "secret"])).annotate({
    description:
      'Which part of the stored credential to type: "secret" (default) or "username". Only used when credential is set.',
  }),
})

type ActResponse = {
  ok: true
  result: {
    success: boolean
    status?: string
    message?: string
    text?: string
    length?: number
    hash?: string
    observation?: { id: string; text?: string; metadata?: Record<string, unknown> }
    verification?: { status?: string; message?: string }
    command?: {
      exitCode: number | null
      stdout: string
      stderr: string
      truncated?: boolean
      timedOut?: boolean
      durationMs?: number
    }
    metadata?: {
      target?: { role?: string; name?: string }
      stateDelta?: { summary?: string; hasChanges?: boolean; highlights?: readonly string[] }
      context?: readonly string[]
      value?: unknown
      credentials?: readonly {
        id?: string
        name?: string
        kind?: string
        username?: string
        enabled?: boolean
        rules?: readonly { kind?: string; match?: string }[]
      }[]
      credential?: { id?: string; name?: string }
      exitCode?: number | null
      preview?: string
      length?: number
      hash?: string
    }
    error?: {
      code?: string
      message: string
      details?: { missing?: readonly string[]; credential?: { name?: string } }
    }
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
  set_value: "Set value of",
  select: "Selected",
  toggle: "Toggled",
  expand: "Expanded",
  collapse: "Collapsed",
  increment: "Incremented",
  decrement: "Decremented",
  scroll_into_view: "Scrolled into view",
  read_value: "Read value",
  run_command: "Ran command",
  credentials: "Listed credentials",
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
          validateAction(params)
          const config = yield* configFromEnv()
          yield* ctx.ask({
            permission: "computer",
            patterns: [actPermissionPattern(params)],
            always: alwaysPatternsForAct(params.action),
            metadata: {
              operation: "act",
              action: params.action,
              ...(params.target === undefined ? {} : { target: params.target }),
              ...(params.query === undefined ? {} : { query: params.query }),
              ...(params.app === undefined ? {} : { app: params.app }),
              ...(params.text === undefined ? {} : { text: permissionText(params.action, params.text) }),
              ...(params.key === undefined ? {} : { key: params.key }),
              ...(params.command === undefined ? {} : { command: shortenCommand(params.command) }),
              ...(params.credential === undefined ? {} : { credential: params.credential }),
            },
          })
          const id = yield* computerId(http, config, ctx.sessionID)
          const result = yield* request<ActResponse>(
            http,
            config,
            "POST",
            `/v1/computers/${id}/actions`,
            {
              action: params.action,
              ...(params.target === undefined
                ? {}
                : {
                    target: {
                      elementId: params.target,
                      ...(params.observationId === undefined ? {} : { observationId: params.observationId }),
                    },
                  }),
              ...(params.observationId === undefined ? {} : { observationId: params.observationId }),
              ...(params.query === undefined ? {} : { query: params.query }),
              ...(params.role === undefined ? {} : { role: params.role }),
              ...(params.window === undefined ? {} : { window: params.window }),
              ...(params.text === undefined && params.position === undefined && params.point === undefined
                ? {}
                : { text: params.text ?? params.position ?? params.point }),
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
              ...(params.command === undefined ? {} : { command: params.command }),
              ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
              ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
              ...(params.credential === undefined ? {} : { credential: params.credential }),
              ...(params.field === undefined ? {} : { field: params.field }),
              approve: true,
              approvedBy: `session:${ctx.sessionID}`,
              approvedScopes: scopesForAct(params),
              sessionId: ctx.sessionID,
            },
            { validate: Schema.is(ActionEnvelope) },
          )
          const outcome = result.result
          const targetName =
            typeof outcome.metadata?.target?.name === "string" && outcome.metadata.target.name.length > 0
              ? outcome.metadata.target.name
              : (params.target ??
                params.query ??
                params.app ??
                params.url ??
                params.path ??
                shortenCommand(params.command) ??
                "desktop")
          const verification = outcome.verification?.status ?? (outcome.success ? "unverified" : "failed")
          const statusLabel = !outcome.success ? (outcome.error?.code ?? outcome.status ?? "failed") : verification
          const title = `${ACTION_LABEL[params.action] ?? params.action} ${targetName} (${statusLabel})`
          yield* ctx.metadata({ title, metadata: {} })
          const lines = [outcome.message ?? `${params.action} ${outcome.success ? "completed" : "did not complete"}.`]
          if (outcome.metadata?.stateDelta?.summary)
            lines.push(`observed change: ${outcome.metadata.stateDelta.summary}`)
          if (outcome.command) {
            lines.push(`exit code: ${outcome.command.exitCode ?? "unknown"}`)
            if (outcome.command.stdout.trim().length > 0)
              lines.push(`stdout:\n${clip(outcome.command.stdout, CAPS.actText)}`)
            if (outcome.command.stderr.trim().length > 0)
              lines.push(`stderr:\n${clip(outcome.command.stderr, CAPS.actText)}`)
            if (outcome.command.truncated === true)
              lines.push("output was truncated; redirect to a file if you need all of it.")
          }
          if (params.action === "read_value" && outcome.metadata?.value !== undefined) {
            lines.push(`value: ${clip(JSON.stringify(outcome.metadata.value), CAPS.actText)}`)
          }
          if (params.action === "read_clipboard" && outcome.success) {
            const clipboard = outcome.text ?? outcome.metadata?.preview
            if (clipboard !== undefined && clipboard.length > 0) {
              lines.push(`clipboard:\n${clip(clipboard, CAPS.actText)}`)
            }
            const length = outcome.length ?? outcome.metadata?.length
            const hash = outcome.hash ?? outcome.metadata?.hash
            if (length !== undefined) lines.push(`[length=${length}${hash === undefined ? "" : ` hash=${hash}`}]`)
          }
          const storedCredentials = outcome.metadata?.credentials
          if (storedCredentials !== undefined) {
            if (storedCredentials.length === 0) lines.push("no stored credentials for this computer.")
            else {
              lines.push("stored credentials:")
              for (const entry of storedCredentials.slice(0, CAPS.credentialEntries)) {
                const rules = (entry.rules ?? []).map((rule) => `${rule.kind ?? "rule"}:${rule.match ?? ""}`).join(", ")
                lines.push(
                  `- ${entry.name ?? entry.id ?? "credential"} (${entry.kind ?? "password"})${entry.username === undefined ? "" : ` username ${entry.username}`}${rules.length === 0 ? "" : `; use for ${rules}`}${entry.enabled === false ? " [disabled]" : ""}`,
                )
              }
              if (storedCredentials.length > CAPS.credentialEntries) {
                lines.push(
                  `… [truncated: ${storedCredentials.length - CAPS.credentialEntries} of ${storedCredentials.length} credentials omitted]`,
                )
              }
              lines.push(
                'pass credential: "auto" to run_command to use the matching credential; the secret stays hidden.',
              )
            }
          }
          if (!outcome.success && outcome.error?.details?.credential?.name) {
            lines.push(
              `a stored credential "${outcome.error.details.credential.name}" matches this command; retry with credential: "auto" to use it.`,
            )
          }
          if (!outcome.success && Array.isArray(outcome.metadata?.context) && outcome.metadata.context.length > 0) {
            lines.push("current interface context:")
            for (const entry of outcome.metadata.context.slice(0, CAPS.actContextEntries)) lines.push(`- ${entry}`)
          }
          if (outcome.verification !== undefined) {
            const message = outcome.verification.message
            lines.push(
              message !== undefined && message !== outcome.metadata?.stateDelta?.summary
                ? `verification: ${verification} — ${message}`
                : `verification: ${verification}`,
            )
          }
          if (outcome.observation) {
            lines.push(
              `fresh observation ${outcome.observation.id}: re-read it with computer_observe or computer_find before the next action.`,
            )
          }
          if (outcome.error && !outcome.success)
            lines.push(`error: ${renderFailure(outcome.error, "The action failed.")}`)
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
