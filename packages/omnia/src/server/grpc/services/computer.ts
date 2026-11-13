import type { ServerUnaryCall, sendUnaryData } from "@grpc/grpc-js"
import { status as GrpcStatus } from "@grpc/grpc-js"
import type { SecurityRecord } from "../../../security/journal"
import type { ComputerManager } from "../../computers"
import type { GnmiAccess, GnmiStateSource } from "../state"
import type { GrpcPrincipal } from "../auth"
import { GrpcError } from "../types"

export interface ComputerMessage {
  readonly id: string
  readonly name: string
  readonly platform: string
  readonly architecture: string
  readonly backend: string
  readonly driver: string
  readonly connected: boolean
  readonly last_seen: string
  readonly capabilities: readonly {
    readonly name: string
    readonly status: string
    readonly score: number
    readonly reason: string
    readonly metadata_json: string
  }[]
}

export interface ComputerOperationResponse {
  readonly ok: boolean
  readonly status: string
  readonly message: string
  readonly computer?: ComputerMessage
}

export interface HealthCheckResponse {
  readonly status: string
  readonly version: string
  readonly protocol: number
  readonly uptime_ms: string
  readonly active_sessions: number
  readonly connected_computers: number
  readonly server_id: string
}

export interface ComputerServiceDeps {
  readonly computers: ComputerManager
  readonly source: GnmiStateSource
  readonly now: () => number
  readonly serverId: string
  readonly audit: (record: SecurityRecord) => void
}

export type UnaryHandler<Request, Response> = (
  call: ServerUnaryCall<Request, Response>,
  callback: sendUnaryData<Response>,
  access: GnmiAccess,
  principal: GrpcPrincipal,
) => void | Promise<void>

export interface ComputerHandlers {
  readonly ListComputers: UnaryHandler<Record<string, never>, { readonly computers: readonly ComputerMessage[] }>
  readonly GetComputer: UnaryHandler<{ readonly id: string }, ComputerMessage>
  readonly ConnectComputer: UnaryHandler<{ readonly id: string }, ComputerOperationResponse>
  readonly DisconnectComputer: UnaryHandler<{ readonly id: string }, ComputerOperationResponse>
  readonly Check: UnaryHandler<{ readonly service?: string }, HealthCheckResponse>
}

export function createComputerHandlers(deps: ComputerServiceDeps): ComputerHandlers {
  return {
    ListComputers: async (_call, callback, access) => {
      const computers = (await deps.source.computers()).filter((computer) => access.visibleComputer(computer.id))
      callback(null, { computers: computers.map(computerMessage) })
    },

    GetComputer: async (call, callback, access) => {
      const id = call.request.id?.trim()
      if (id === undefined || id.length === 0) throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, "A computer id is required.")
      if (!access.visibleComputer(id)) throw new GrpcError(GrpcStatus.PERMISSION_DENIED, "That computer is not visible to this caller.")
      const computer = (await deps.source.computers()).find((entry) => entry.id === id)
      if (computer === undefined) throw new GrpcError(GrpcStatus.NOT_FOUND, `Unknown computer ${id}.`)
      callback(null, computerMessage(computer))
    },

    ConnectComputer: async (call, callback, access, principal) => {
      const id = requireId(call.request.id)
      if (!access.operator) throw new GrpcError(GrpcStatus.PERMISSION_DENIED, "Only the deployment operator may connect a computer.")
      // Record before mutating so a journal failure refuses the operation.
      deps.audit({ type: "grpc.computer.connect", at: deps.now(), serverId: deps.serverId, route: id, actor: principal.actor })
      const outcome = await deps.computers.connect(id)
      callback(null, await operation(outcome, id, deps.source))
    },

    DisconnectComputer: async (call, callback, access, principal) => {
      const id = requireId(call.request.id)
      if (!access.operator) throw new GrpcError(GrpcStatus.PERMISSION_DENIED, "Only the deployment operator may disconnect a computer.")
      // Record before mutating so a journal failure refuses the operation.
      deps.audit({ type: "grpc.computer.disconnect", at: deps.now(), serverId: deps.serverId, route: id, actor: principal.actor })
      const outcome = await deps.computers.disconnect(id)
      callback(null, await operation(outcome, id, deps.source))
    },

    Check: (_call, callback) => {
      const health = deps.source.health()
      // gRPC health only distinguishes serving from not serving. A server that
      // is still starting or has failed must not claim to serve traffic.
      const serving = health.status === "ready" || health.status === "degraded"
      callback(null, {
        status: serving ? "SERVING" : "NOT_SERVING",
        version: health.version,
        protocol: health.protocol,
        uptime_ms: String(health.uptimeMs),
        active_sessions: health.activeSessions,
        connected_computers: health.connectedComputers,
        server_id: health.serverId,
      })
    },
  }
}

function requireId(value: string | undefined): string {
  const id = value?.trim()
  if (id === undefined || id.length === 0) throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, "A computer id is required.")
  return id
}

async function operation(
  outcome: Awaited<ReturnType<ComputerManager["connect"]>>,
  id: string,
  source: GnmiStateSource,
): Promise<ComputerOperationResponse> {
  const result = outcome.result
  const computer = (await source.computers()).find((entry) => entry.id === id)
  return {
    ok: result.success,
    status: result.status ?? (result.success ? "success" : "failed"),
    message: typeof result.message === "string" ? result.message : "",
    ...(computer === undefined ? {} : { computer: computerMessage(computer) }),
  }
}

function computerMessage(computer: Awaited<ReturnType<GnmiStateSource["computers"]>>[number]): ComputerMessage {
  return {
    id: computer.id,
    name: computer.name,
    platform: computer.platform,
    architecture: computer.architecture ?? "",
    backend: computer.backend,
    driver: computer.driver,
    connected: computer.connected,
    last_seen: String(computer.lastSeen ?? 0),
    capabilities: computer.capabilities.map((capability) => ({
      name: capability.capability,
      status: capability.status,
      score: capability.score ?? 0,
      reason: capability.reason ?? "",
      metadata_json: JSON.stringify(capability.metadata ?? {}),
    })),
  }
}
