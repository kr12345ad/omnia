import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./capabilities.txt"
import { configFromEnv, computerId, request } from "./client"

export const Parameters = Schema.Struct({})

type ComputerResponse = {
  ok: true
  computer: {
    id: string
    name: string
    platform: string
    backend: string
    connected: boolean
    capabilities: Array<{ capability: string; status: string; score?: number; reason?: string }>
  }
}

type HealthResponse = {
  ok: true
  health: {
    status: string
    version: string
    protocol: number
    uptimeMs: number
    connectedComputers: number
    subsystems: Array<{ name: string; status: string; reason?: string }>
  }
}

export const ComputerCapabilitiesTool = Tool.define<typeof Parameters, Record<string, unknown>, HttpClient.HttpClient>(
  "computer_capabilities",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params, ctx) =>
        Effect.gen(function* () {
          const config = yield* configFromEnv()
          const id = yield* computerId(http, config)
          const [computer, health] = yield* Effect.all([
            request<ComputerResponse>(http, config, "GET", `/v1/computers/${id}`),
            request<HealthResponse>(http, config, "GET", "/v1/health"),
          ])
          const info = computer.computer
          const lines = [
            `Omnia Server ${health.health.version} (status ${health.health.status}, protocol v${health.health.protocol}, uptime ${Math.round(health.health.uptimeMs / 1000)}s)`,
            `${info.name} (${info.platform}, backend ${info.backend}, connected: ${info.connected})`,
            ...info.capabilities.map(
              (capability) =>
                `- ${capability.capability}: ${capability.status}${capability.reason ? ` — ${capability.reason}` : ""}`,
            ),
            ...health.health.subsystems.map(
              (subsystem) => `- server.${subsystem.name}: ${subsystem.status}${subsystem.reason ? ` — ${subsystem.reason}` : ""}`,
            ),
          ]
          const title = `Computer capabilities: ${info.platform}`
          yield* ctx.metadata({ title, metadata: {} })
          return {
            title,
            output: lines.join("\n"),
            metadata: {
              platform: info.platform,
              backend: info.backend,
              connected: info.connected,
              serverStatus: health.health.status,
              capabilities: info.capabilities.map((capability) => `${capability.capability}=${capability.status}`),
            },
          }
        }),
    }
  }),
)
