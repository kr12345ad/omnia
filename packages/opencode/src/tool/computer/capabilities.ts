import { Cause, Effect, Exit, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./capabilities.txt"
import { configFromEnv, computerId, request } from "./client"
import { CAPS, clipLines } from "./output"

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

function failureText(exit: Exit.Exit<unknown, never>): string {
  if (Exit.isSuccess(exit)) return "unknown failure"
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error.message : String(error)
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
          const id = yield* computerId(http, config, ctx.sessionID)
          const [computer, health] = yield* Effect.all([
            request<ComputerResponse>(http, config, "GET", `/v1/computers/${id}`).pipe(Effect.exit),
            request<HealthResponse>(http, config, "GET", "/v1/health").pipe(Effect.exit),
          ])
          if (Exit.isFailure(computer) && Exit.isFailure(health)) {
            throw new Error(
              `The Omnia Server did not answer the capability or health request: ${failureText(computer)}; ${failureText(health)}`,
            )
          }
          const info = Exit.isSuccess(computer) ? computer.value.computer : undefined
          const lines = [
            Exit.isSuccess(health)
              ? `Omnia Server ${health.value.health.version} (status ${health.value.health.status}, protocol v${health.value.health.protocol}, uptime ${Math.round(health.value.health.uptimeMs / 1000)}s)`
              : `server status unavailable: ${failureText(health)}`,
            ...(info === undefined
              ? [`computer details unavailable: ${failureText(computer)}`]
              : [
                  `${info.name} (${info.platform}, backend ${info.backend}, connected: ${info.connected})`,
                  ...info.capabilities.map(
                    (capability) =>
                      `- ${capability.capability}: ${capability.status}${capability.reason ? ` — ${capability.reason}` : ""}`,
                  ),
                ]),
            ...(Exit.isSuccess(health)
              ? health.value.health.subsystems.map(
                  (subsystem) =>
                    `- server.${subsystem.name}: ${subsystem.status}${subsystem.reason ? ` — ${subsystem.reason}` : ""}`,
                )
              : []),
          ]
          const degraded = info === undefined || Exit.isFailure(health)
          if (degraded) lines.push("Retry once the missing half of the Omnia Server answers; this report is incomplete.")
          const title =
            info === undefined ? "Computer capabilities (incomplete)" : `Computer capabilities: ${info.platform}`
          yield* ctx.metadata({ title, metadata: {} })
          return {
            title,
            output: clipLines(lines, CAPS.capabilities).join("\n"),
            metadata: {
              ...(info === undefined ? {} : { platform: info.platform, backend: info.backend, connected: info.connected }),
              ...(Exit.isSuccess(health) ? { serverStatus: health.value.health.status } : {}),
              ...(info === undefined
                ? {}
                : { capabilities: info.capabilities.map((capability) => `${capability.capability}=${capability.status}`) }),
              degraded,
            },
          }
        }),
    }
  }),
)
