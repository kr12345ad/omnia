import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Session } from "@/session/session"
import { Tool } from "../tool"
import {
  COMPUTER_SELECTION_METADATA_KEY,
  configFromEnv,
  controlPlaneKey,
  request,
} from "./client"
import DESCRIPTION from "./switch.txt"

export const Parameters = Schema.Struct({
  computerId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))).annotate({
    description: "Paired computer ID, exact name, or unambiguous platform (macOS, Windows, Linux). Omit to list computers and the current target without switching.",
  }),
})

const Computers = Schema.Struct({
  ok: Schema.Boolean,
  computers: Schema.Array(Schema.Struct({
    id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)),
    name: Schema.optional(Schema.String),
    platform: Schema.optional(Schema.String),
    connected: Schema.Boolean,
  })),
})

export const SwitchComputerTool = Tool.define<
  typeof Parameters,
  Record<string, unknown>,
  HttpClient.HttpClient | Session.Service
>(
  "switch_computer",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const sessions = yield* Session.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) => Effect.gen(function* () {
        const config = yield* configFromEnv()
        const response = yield* request<typeof Computers.Type>(
          http, config, "GET", "/v1/computers", undefined, { validate: Schema.is(Computers) },
        )
        const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
        // Listing still works if a previously saved control-plane binding changed;
        // an explicit successful switch below repairs that binding.
        const saved = session.metadata?.[COMPUTER_SELECTION_METADATA_KEY]
        const previousId = typeof saved === "object" && saved !== null && "id" in saved && typeof saved.id === "string"
          ? saved.id : config.computerId
        if (params.computerId === undefined) {
          const title = "Paired computers"
          const belongsHere = typeof saved === "object" && saved !== null && "server" in saved && saved.server === controlPlaneKey(config)
          const selected = belongsHere ? previousId : config.computerId
          return {
            title,
            output: JSON.stringify({
              currentComputerId: selected ?? null,
              selection: selected ? "explicit" : "automatic: first connected computer",
              ...(saved !== undefined && !belongsHere ? { warning: "The saved target belongs to another control plane. Select a device again before acting." } : {}),
              computers: response.computers,
            }, null, 2),
            metadata: { switched: false, currentComputerId: selected, computers: response.computers },
          }
        }
        const query = params.computerId.trim()
        if (!query) throw new Error("Choose a non-empty computer ID, name, or platform.")
        const normalized = query.toLowerCase()
        const aliases: Record<string, string> = { mac: "darwin", macos: "darwin", windows: "win32", linux: "linux" }
        const platform = Object.hasOwn(aliases, normalized) ? aliases[normalized] : normalized
        const exact = response.computers.find((computer) => computer.id === query)
        const byName = response.computers.filter((computer) => computer.name?.toLowerCase() === normalized)
        const candidates = exact ? [exact] : byName.length ? byName : response.computers.filter((computer) =>
          computer.platform?.toLowerCase() === platform,
        )
        if (candidates.length === 0) throw new Error(`No paired computer matches "${query}". Call switch_computer without arguments to list IDs.`)
        if (candidates.length > 1) throw new Error(`"${query}" matches several computers (${candidates.map((computer) => computer.id).join(", ")}). Choose an exact ID.`)
        const target = candidates[0]!
        if (!target.connected) throw new Error(`Computer ${target.id} is offline. Open Omnia on that device, then retry. The session target was not changed.`)
        yield* ctx.ask({
          permission: "computer",
          patterns: [`switch:${target.id}`],
          always: [`switch:${target.id}`],
          metadata: { operation: "switch_computer", computerId: target.id, computerName: target.name },
        })
        if (ctx.abort.aborted) throw new Error("Computer switch was cancelled; the session target was not changed.")
        // Re-read before writing so unrelated session metadata is preserved.
        const current = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
        yield* sessions.setMetadata({
          sessionID: ctx.sessionID,
          metadata: {
            ...current.metadata,
            [COMPUTER_SELECTION_METADATA_KEY]: { id: target.id, server: controlPlaneKey(config) },
          },
        })
        const title = `Switched to ${target.name ?? target.id}`
        return {
          title,
          output: JSON.stringify({
            switched: true,
            previousComputerId: previousId ?? null,
            computerId: target.id,
            name: target.name,
            platform: target.platform,
            next: "All computer tools in this session now target this device. Discard previous device refs and browser tab IDs; get a fresh computer_snapshot. Permissions are unchanged.",
          }, null, 2),
          metadata: { switched: true, computerId: target.id, previousComputerId: previousId, platform: target.platform },
        }
      }),
    }
  }),
)
