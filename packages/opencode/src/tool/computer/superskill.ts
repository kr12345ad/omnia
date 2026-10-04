import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./superskill.txt"
import { configFromEnv, request } from "./client"
import { CAPS, clip, renderFailure, type FailureError } from "./output"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "describe", "call", "save", "delete"]).annotate({
    description: "What to do with superskills.",
  }),
  skill: Schema.optional(Schema.String).annotate({ description: "Superskill id for describe, call, and delete." }),
  method: Schema.optional(Schema.String).annotate({ description: "Bridge method for call." }),
  params: Schema.optional(Schema.Unknown).annotate({ description: "Parameters object for the bridge method." }),
  definition: Schema.optional(Schema.Unknown).annotate({
    description:
      "Full superskill definition for save: { id, name, description, instructions, enabled, version?, author?, scopes?, bridge: { type: 'stdio'|'http', command?|url?, timeoutMs? }, methods: [{ name, description, parameters?, scopes? }] }.",
  }),
})

type Summary = {
  id: string
  name: string
  description: string
  enabled: boolean
  bridgeType: string
  methods: string[]
}

type SuperskillEnvelope = {
  ok?: boolean
  error?: FailureError | string
  result?: { success?: boolean; message?: string; error?: FailureError }
}

// The server reports a permission denial or a rejected save as ok:false with a
// structured result. Without this check the tool dereferences fields that a
// denial never returns. `bridgePayload` marks the call route, whose `result` is
// the bridge's own return value rather than a status envelope, so only ok:false
// is a failure there.
function superskillFailure(response: unknown, path: string, bridgePayload = false): string | undefined {
  if (typeof response !== "object" || response === null) return undefined
  const envelope = response as SuperskillEnvelope
  const failed =
    envelope.ok === false ||
    (envelope.result?.success === false && envelope.result.error !== undefined && !bridgePayload)
  if (!failed) return undefined
  const fallback =
    typeof envelope.error === "string" && envelope.error.length > 0
      ? envelope.error
      : (envelope.result?.message ?? `The superskill request ${path} failed.`)
  const error =
    envelope.result?.error ??
    (typeof envelope.error === "object" && envelope.error !== null ? envelope.error : undefined)
  return renderFailure(error, fallback)
}

export const SuperskillTool = Tool.define<typeof Parameters, Record<string, unknown>, HttpClient.HttpClient>(
  "superskill",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const config = yield* configFromEnv()
          const call = <Response>(
            method: "GET" | "POST" | "DELETE",
            path: string,
            body?: unknown,
            bridgePayload = false,
          ) =>
            request<Response>(http, config, method, path, body).pipe(
              Effect.tap((response) =>
                Effect.sync(() => {
                  const failure = superskillFailure(response, path, bridgePayload)
                  if (failure !== undefined) throw new Error(failure)
                }),
              ),
            )

          if (params.action === "save") {
            if (params.definition === undefined || typeof params.definition !== "object") {
              throw new Error("The save action requires definition.")
            }
            yield* ctx.ask({
              permission: "computer",
              patterns: [`superskill:save`],
              always: ["superskill:save"],
              metadata: { operation: "superskill", action: "save" },
            })
            const saved = yield* call<{ superskill: { id: string; name: string } }>(
              "POST",
              "/v1/superskills",
              params.definition,
            )
            const title = `Saved superskill ${saved.superskill.name}`
            yield* ctx.metadata({ title, metadata: {} })
            return {
              title,
              output: `Saved superskill ${saved.superskill.id}. It appears in Settings > Superskills and can be enabled or disabled there.`,
              metadata: { success: true, skill: saved.superskill.id },
            }
          }

          if (params.action === "delete") {
            if (params.skill === undefined || params.skill.length === 0)
              throw new Error("The delete action requires skill.")
            yield* ctx.ask({
              permission: "computer",
              patterns: [`superskill:delete:${params.skill}`],
              always: ["superskill:delete:*"],
              metadata: { operation: "superskill", action: "delete", skill: params.skill },
            })
            const removed = yield* call<{ removed: boolean }>(
              "DELETE",
              `/v1/superskills/${encodeURIComponent(params.skill)}`,
            )
            const title = removed.removed
              ? `Deleted superskill ${params.skill}`
              : `Superskill ${params.skill} not found`
            yield* ctx.metadata({ title, metadata: {} })
            return { title, output: title, metadata: { success: removed.removed } }
          }

          if (params.action === "list") {
            const result = yield* call<{ superskills: Summary[] }>("GET", "/v1/superskills")
            const skills = result.superskills ?? []
            const title = `${skills.length} superskill(s)`
            yield* ctx.metadata({ title, metadata: {} })
            const lines = skills.map(
              (skill) =>
                `- ${skill.name} (id=${skill.id}, ${skill.bridgeType})${skill.enabled ? "" : " [disabled]"} — ${skill.description}\n  methods: ${skill.methods.join(", ")}`,
            )
            return {
              title,
              output: lines.length === 0 ? "No superskills are defined yet." : lines.join("\n"),
              metadata: { success: true, count: skills.length },
            }
          }

          if (params.skill === undefined || params.skill.length === 0) {
            throw new Error(`The ${params.action} action requires skill.`)
          }

          if (params.action === "describe") {
            const result = yield* call<{
              superskill: {
                id: string
                name: string
                description: string
                instructions: string
                enabled: boolean
                methods: Array<{
                  name: string
                  description: string
                  parameters?: Record<string, unknown>
                  scopes?: string[]
                }>
              }
            }>("GET", `/v1/superskills/${encodeURIComponent(params.skill)}`)
            const skill = result.superskill
            yield* ctx.ask({
              permission: "computer",
              patterns: [`superskill:describe:${skill.id}`],
              always: ["superskill:describe:*"],
              metadata: { operation: "superskill", action: "describe", skill: skill.id },
            })
            const title = `Superskill ${skill.name}`
            yield* ctx.metadata({ title, metadata: {} })
            const lines = [
              `${skill.name} (id=${skill.id})${skill.enabled ? "" : " [disabled]"}`,
              skill.description,
              "",
              "Instructions:",
              clip(skill.instructions, CAPS.superskillInstructions),
              "",
              "Methods:",
              ...skill.methods.map(
                (method) =>
                  `- ${method.name}: ${method.description}${method.scopes === undefined || method.scopes.length === 0 ? "" : ` (scopes: ${method.scopes.join(", ")})`}${method.parameters === undefined ? "" : `\n  parameters: ${clip(JSON.stringify(method.parameters), 2000)}`}`,
              ),
            ]
            return { title, output: lines.join("\n"), metadata: { success: true, skill: skill.id } }
          }

          if (params.method === undefined || params.method.length === 0) {
            throw new Error("The call action requires method.")
          }
          yield* ctx.ask({
            permission: "computer",
            patterns: [`superskill:call:${params.skill}:${params.method}`],
            always: ["superskill:call:*"],
            metadata: { operation: "superskill", action: "call", skill: params.skill, method: params.method },
          })
          const definition = yield* call<{
            superskill: {
              scopes?: string[]
              bridge?: { type?: string }
              methods?: Array<{ name: string; scopes?: string[] }>
            }
          }>("GET", `/v1/superskills/${encodeURIComponent(params.skill)}`)
          const method = (definition.superskill.methods ?? []).find((entry) => entry.name === params.method)
          const methodScopes = method?.scopes ?? []
          const skillScopes = definition.superskill.scopes ?? []
          const requiredScopes =
            methodScopes.length > 0
              ? methodScopes
              : skillScopes.length > 0
                ? skillScopes
                : definition.superskill.bridge?.type === "stdio"
                  ? ["PROCESS_EXECUTE"]
                  : ["NETWORK"]
          // The call route answers with the bridge's own payload in `result`, so
          // only the envelope decides whether the call was allowed to run.
          const result = yield* call<{ result: unknown }>(
            "POST",
            `/v1/superskills/${encodeURIComponent(params.skill)}/call`,
            {
              method: params.method,
              params: params.params ?? {},
              approve: true,
              approvedBy: `session:${ctx.sessionID}`,
              approvedScopes: requiredScopes,
              sessionId: ctx.sessionID,
            },
            true,
          )
          const title = `Superskill ${params.skill}.${params.method}`
          yield* ctx.metadata({ title, metadata: {} })
          const rendered = JSON.stringify(result.result)
          return {
            title,
            output: clip(rendered, CAPS.superskillResult),
            metadata: { success: true, skill: params.skill, method: params.method },
          }
        }),
    }
  }),
)
