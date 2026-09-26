import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./memory.txt"
import { configFromEnv, request } from "./client"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["recall", "remember", "forget", "list", "stats"]).annotate({
    description: "What to do with memory.",
  }),
  query: Schema.optional(Schema.String).annotate({ description: "Search text for recall and forget." }),
  text: Schema.optional(Schema.String).annotate({ description: "Memory text for remember." }),
  scope: Schema.optional(
    Schema.Literals(["session", "task", "workspace", "user", "skill", "application"]),
  ).annotate({ description: "Memory scope." }),
  key: Schema.optional(Schema.String).annotate({
    description: "Stable key for remember, for example application:calc:export-steps. Updates the existing memory.",
  }),
  application: Schema.optional(Schema.String).annotate({ description: "Application this memory is about." }),
  tags: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Tags for recall filtering and remember." }),
  confidence: Schema.optional(Schema.Number).annotate({ description: "Confidence 0 to 1. Defaults to 0.8." }),
  expiresInDays: Schema.optional(Schema.Number).annotate({ description: "Expire the memory after this many days." }),
  id: Schema.optional(Schema.String).annotate({ description: "Memory id for a targeted forget." }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Maximum results. Defaults to 10 for recall, 50 for list." }),
})

type MemoryRecord = {
  id: string
  scope: string
  text: string
  key?: string
  tags?: string[]
  application?: string
  confidence: number
  sensitivity: string
  createdAt: number
  updatedAt: number
  expiresAt?: number
}

function age(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function describe(record: MemoryRecord): string {
  const parts = [`[${record.scope}]`, record.text]
  if (record.key !== undefined) parts.push(`(key=${record.key})`)
  if (record.application !== undefined) parts.push(`app=${record.application}`)
  parts.push(`confidence=${record.confidence.toFixed(2)}`)
  parts.push(`age=${age(record.updatedAt)}`)
  return parts.join(" ")
}

export const MemoryTool = Tool.define<typeof Parameters, Record<string, unknown>, HttpClient.HttpClient>(
  "memory",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const config = yield* configFromEnv()
          const call = <Response>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) =>
            request<Response>(http, config, method, path, body)

          if (params.action === "stats") {
            const result = yield* call<{ stats: { total: number; byScope: Record<string, number>; expiringSoon: number } }>(
              "GET",
              "/v1/memories/stats",
            )
            const title = `${result.stats.total} memories`
            yield* ctx.metadata({ title, metadata: {} })
            const lines = Object.entries(result.stats.byScope).map(([scope, count]) => `- ${scope}: ${count}`)
            if (result.stats.expiringSoon > 0) lines.push(`expiring within a week: ${result.stats.expiringSoon}`)
            return {
              title,
              output: lines.length === 0 ? "No memories yet." : lines.join("\n"),
              metadata: { success: true, ...result.stats },
            }
          }

          if (params.action === "remember") {
            if (params.text === undefined || params.text.trim().length === 0) {
              throw new Error("The remember action requires text.")
            }
            if (params.scope === undefined) throw new Error("The remember action requires scope.")
            yield* ctx.ask({
              permission: "computer",
              patterns: [`memory:remember:${params.key ?? params.scope}`],
              always: ["*"],
              metadata: { operation: "memory", action: "remember", scope: params.scope, key: params.key },
            })
            const result = yield* call<{ memory: MemoryRecord }>("POST", "/v1/memories", {
              scope: params.scope,
              text: params.text,
              ...(params.key === undefined ? {} : { key: params.key }),
              ...(params.application === undefined ? {} : { application: params.application }),
              ...(params.tags === undefined ? {} : { tags: [...params.tags] }),
              ...(params.confidence === undefined ? {} : { confidence: params.confidence }),
              ...(params.expiresInDays === undefined ? {} : { expiresInDays: params.expiresInDays }),
              sessionId: ctx.sessionID,
              approve: true,
              approvedBy: `session:${ctx.sessionID}`,
              approvedScopes: ["FILES_WRITE"],
            })
            const title = `Remembered (${result.memory.scope})`
            yield* ctx.metadata({ title, metadata: {} })
            return {
              title,
              output: `${describe(result.memory)}\nid=${result.memory.id}`,
              metadata: { success: true, id: result.memory.id },
            }
          }

          if (params.action === "forget") {
            yield* ctx.ask({
              permission: "computer",
              patterns: [`memory:forget:${params.id ?? params.query ?? params.scope ?? "all"}`],
              always: ["*"],
              metadata: { operation: "memory", action: "forget", query: params.query, id: params.id },
            })
            if (params.id !== undefined) {
              const result = yield* call<{ removed: boolean }>("DELETE", `/v1/memories/${encodeURIComponent(params.id)}`)
              const title = result.removed ? `Forgot ${params.id}` : `Memory ${params.id} not found`
              yield* ctx.metadata({ title, metadata: {} })
              return { title, output: title, metadata: { success: result.removed } }
            }
            if (params.query === undefined && params.key === undefined && params.scope === undefined && params.application === undefined) {
              throw new Error("The forget action requires id, query, key, scope, or application.")
            }
            const result = yield* call<{ removed: number }>("POST", "/v1/memories/forget", {
              ...(params.query === undefined ? {} : { query: params.query }),
              ...(params.key === undefined ? {} : { key: params.key }),
              ...(params.scope === undefined ? {} : { scope: params.scope }),
              ...(params.application === undefined ? {} : { application: params.application }),
              sessionId: ctx.sessionID,
              approve: true,
              approvedBy: `session:${ctx.sessionID}`,
              approvedScopes: ["FILES_WRITE"],
            })
            const title = `Forgot ${result.removed} memories`
            yield* ctx.metadata({ title, metadata: {} })
            return { title, output: title, metadata: { success: true, removed: result.removed } }
          }

          const query = new URLSearchParams()
          if (params.query !== undefined && params.query.length > 0) query.set("query", params.query)
          if (params.scope !== undefined) query.set("scope", params.scope)
          if (params.application !== undefined) query.set("application", params.application)
          if (params.key !== undefined) query.set("key", params.key)
          if (params.tags !== undefined && params.tags.length > 0) query.set("tags", params.tags.join(","))
          query.set("limit", String(params.limit ?? (params.action === "list" ? 50 : 10)))
          const result = yield* call<{ memories: MemoryRecord[]; total: number }>(
            "GET",
            `/v1/memories?${query.toString()}`,
          )
          const title =
            params.action === "list" ? `${result.memories.length} recent memories` : `${result.memories.length} matches`
          yield* ctx.metadata({ title, metadata: {} })
          return {
            title,
            output: result.memories.length === 0 ? "No memories matched." : result.memories.map(describe).join("\n"),
            metadata: {
              success: true,
              count: result.memories.length,
              ids: result.memories.map((record) => record.id).slice(0, 20),
            },
          }
        }),
    }
  }),
)
