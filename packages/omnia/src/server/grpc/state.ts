import type { ChatChannelSummary } from "../../chat/service"
import type { CapabilitySupport } from "../../protocol"
import type { ComputerSummary } from "../computers"
import type { ServerHealth, ServerSession } from "../api"
import type { OmniaScope, PermissionState } from "../permissions"
import {
  isConfigPath,
  pathChannelPlatform,
  pathComputerId,
  pathKind,
  pathScopeName,
  pathSessionId,
  type ModelPath,
} from "./paths"

/**
 * The authoritative read side of Omnia. Every field is either an existing
 * server value or a direct projection of one; this module never caches state.
 */
export interface GnmiStateSource {
  readonly url?: string
  readonly health: () => ServerHealth
  readonly computers: () => Promise<readonly ComputerSummary[]>
  readonly sessions: () => readonly ServerSession[]
  readonly chatChannels: () => readonly ChatChannelSummary[]
  readonly permissions: () => Readonly<Record<OmniaScope, PermissionState>>
  readonly execution?: () => ServerExecution | undefined
}

/** The most recent semantic computer-use execution reported by the EventBus. */
export interface ServerExecution {
  readonly at: number
  readonly action: string
  readonly success?: boolean
  readonly verified?: boolean
  readonly provider?: string
  readonly model?: string
  readonly delivery?: string
}

/** The caller-relative view used to filter list data and deny concrete paths. */
export interface GnmiAccess {
  readonly operator: boolean
  readonly chat: boolean
  readonly visibleComputer: (id: string) => boolean
  readonly visibleSession: (session: ServerSession) => boolean
}

export type GnmiDataType = "ALL" | "CONFIG" | "STATE" | "OPERATIONAL"

/**
 * Resolve a canonical path to the JSON_IETF value Omnia publishes.
 *
 * undefined means the path is valid but has no value for this caller or data
 * type. Callers validate the path shape first, so an unknown path is reported
 * as INVALID_ARGUMENT rather than being confused with an empty subtree.
 */
export async function resolvePath(
  path: ModelPath,
  source: GnmiStateSource,
  access: GnmiAccess,
  type: GnmiDataType = "ALL",
): Promise<unknown | undefined> {
  const config = isConfigPath(path)
  const kind = pathKind(path)
  if (kind !== "root") {
    if (type === "CONFIG" && !config) return undefined
    if ((type === "STATE" || type === "OPERATIONAL") && config) return undefined
  }
  if (type !== "ALL" && type !== "CONFIG" && type !== "STATE" && type !== "OPERATIONAL") return undefined

  const elements = path.elements
  const names = elements.map((element) => element.name)
  if (kind === "root") return rootValue(source, access, type)
  if (kind === "unknown") return undefined

  if (kind === "server") {
    const health = source.health()
    const execution = source.execution?.()
    if (names.length === 2) {
      return {
        status: serverStatus(health, source),
        health: serverHealth(health),
        ...(execution === undefined ? {} : { execution: { last: executionJson(execution) } }),
      }
    }
    if (names[2] === "status") return serverStatus(health, source)
    if (names[2] === "health") return serverHealth(health)
    if (names[2] === "execution") {
      if (execution === undefined) return undefined
      if (names.length === 3) return { last: executionJson(execution) }
      if (names[3] === "last") return executionJson(execution)
    }
    return undefined
  }

  if (kind === "computers") {
    const id = pathComputerId(path)
    const computers = (await source.computers()).filter((computer) => access.visibleComputer(computer.id))
    const sessionsFor = (computerId: string) =>
      source.sessions().filter((session) => session.computerId === computerId && access.visibleSession(session))
    if (names.length === 2) return { computer: computers.map((computer) => computerJson(computer, sessionsFor(computer.id))) }
    if (id === undefined) {
      if (names[2] !== "computer") return undefined
      if (names.length === 3) return { computer: computers.map((computer) => computerJson(computer, sessionsFor(computer.id))) }
      return undefined
    }
    const computer = computers.find((entry) => entry.id === id)
    if (computer === undefined) return undefined
    if (names.length === 3) return computerJson(computer, sessionsFor(computer.id))
    const leaf = names[3]
    if (leaf === "status") return computerStatus(computer)
    if (leaf === "capabilities") return { capability: computer.capabilities.map(capabilityJson) }
    if (leaf === "sessions") return { session: sessionsFor(id).map(sessionJson) }
    return undefined
  }

  if (kind === "sessions") {
    const sessions = source.sessions().filter(access.visibleSession)
    const id = pathSessionId(path)
    if (names.length === 2) return { session: sessions.map(sessionJson) }
    if (names[2] !== "session") return undefined
    if (id === undefined) return names.length === 3 ? { session: sessions.map(sessionJson) } : undefined
    const session = sessions.find((entry) => entry.id === id)
    return session === undefined ? undefined : sessionJson(session)
  }

  if (kind === "chat") {
    if (!access.chat) return undefined
    const channels = source.chatChannels()
    if (names[2] !== "channels") return undefined
    if (names.length === 3) return { channel: channels.map(channelJson) }
    const platform = pathChannelPlatform(path)
    if (names[3] !== "channel") return undefined
    if (platform === undefined) return names.length === 4 ? { channel: channels.map(channelJson) } : undefined
    const channel = channels.find((entry) => entry.platform === platform)
    return channel === undefined ? undefined : channelJson(channel)
  }

  if (!access.operator) return undefined
  const permissions = source.permissions()
  if (names[2] !== "permissions") return undefined
  if (names.length === 3) {
    return {
      scope: Object.entries(permissions).map(([name, state]) => ({ name, state })),
    }
  }
  const name = pathScopeName(path)
  if (names[3] !== "scope") return undefined
  // No key means the whole list, not an absent entry.
  if (name === undefined) {
    return names.length === 4
      ? { scope: Object.entries(permissions).map(([scope, state]) => ({ name: scope, state })) }
      : undefined
  }
  // A concrete key that is not an own scope is absent, not a request for the
  // whole list. Object.hasOwn also keeps prototype names such as toString
  // from resolving to a function.
  if (!Object.hasOwn(permissions, name)) return undefined
  if (names.length === 4) return { name, state: permissions[name as OmniaScope] }
  if (names[4] !== "state") return undefined
  return permissions[name as OmniaScope]
}

async function rootValue(
  source: GnmiStateSource,
  access: GnmiAccess,
  type: GnmiDataType,
): Promise<Record<string, unknown>> {
  if (type === "CONFIG") {
    if (!access.operator) return {}
    return {
      config: { permissions: { scope: Object.entries(source.permissions()).map(([name, state]) => ({ name, state })) } },
    }
  }
  const health = source.health()
  const execution = source.execution?.()
  const computers = (await source.computers()).filter((computer) => access.visibleComputer(computer.id))
  return {
    server: {
      status: serverStatus(health, source),
      health: serverHealth(health),
      ...(execution === undefined ? {} : { execution: { last: executionJson(execution) } }),
    },
    computers: {
      computer: computers.map((computer) =>
        computerJson(
          computer,
          source.sessions().filter((session) => session.computerId === computer.id && access.visibleSession(session)),
        ),
      ),
    },
    sessions: { session: source.sessions().filter(access.visibleSession).map(sessionJson) },
    ...(access.chat ? { chat: { channels: { channel: source.chatChannels().map(channelJson) } } } : {}),
    ...(type === "ALL" && access.operator
      ? { config: { permissions: { scope: Object.entries(source.permissions()).map(([name, state]) => ({ name, state })) } } }
      : {}),
  }
}

function serverStatus(health: ServerHealth, source: GnmiStateSource): Record<string, unknown> {
  return {
    state: health.status,
    version: health.version,
    protocol: health.protocol,
    api: health.api,
    "server-id": health.serverId,
    // RFC7951 encodes uint64 leaves as JSON strings, not numbers.
    "started-at": String(health.startedAt),
    "uptime-ms": String(health.uptimeMs),
    ...(source.url === undefined ? {} : { url: source.url }),
  }
}

function executionJson(execution: ServerExecution): Record<string, unknown> {
  return {
    at: String(execution.at),
    action: execution.action,
    ...(execution.success === undefined ? {} : { success: execution.success }),
    ...(execution.verified === undefined ? {} : { verified: execution.verified }),
    ...(execution.provider === undefined ? {} : { provider: execution.provider }),
    ...(execution.model === undefined ? {} : { model: execution.model }),
    ...(execution.delivery === undefined ? {} : { delivery: execution.delivery }),
  }
}

function serverHealth(health: ServerHealth): Record<string, unknown> {
  return {
    status: health.status,
    version: health.version,
    protocol: health.protocol,
    "server-id": health.serverId,
    "uptime-ms": String(health.uptimeMs),
    "active-sessions": health.activeSessions,
    "connected-computers": health.connectedComputers,
    subsystem: health.subsystems.map((entry) => ({
      name: entry.name,
      status: entry.status,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    })),
  }
}

function computerStatus(computer: ComputerSummary): Record<string, unknown> {
  return {
    id: computer.id,
    name: computer.name,
    platform: computer.platform,
    ...(computer.architecture === undefined ? {} : { architecture: computer.architecture }),
    backend: computer.backend,
    driver: computer.driver,
    connected: computer.connected,
    ...(computer.lastSeen === undefined ? {} : { "last-seen": String(computer.lastSeen) }),
  }
}

function computerJson(computer: ComputerSummary, sessions: readonly ServerSession[]): Record<string, unknown> {
  return {
    id: computer.id,
    name: computer.name,
    status: computerStatus(computer),
    capabilities: { capability: computer.capabilities.map(capabilityJson) },
    sessions: { session: sessions.map(sessionJson) },
  }
}

function capabilityJson(capability: CapabilitySupport): Record<string, unknown> {
  return {
    name: capability.capability,
    status: capability.status,
    // decimal64 with fraction-digits 4 is also a JSON string in RFC7951.
    ...(capability.score === undefined ? {} : { score: capability.score.toFixed(4) }),
    ...(capability.reason === undefined ? {} : { reason: capability.reason }),
    ...(capability.permissions === undefined
      ? {}
      : {
          permission: capability.permissions.map((permission) => ({
            id: permission.id,
            description: permission.description,
            status: permission.status,
            ...(permission.capabilities === undefined ? {} : { capability: permission.capabilities }),
            ...(permission.promptable === undefined ? {} : { promptable: permission.promptable }),
            ...(permission.reason === undefined ? {} : { reason: permission.reason }),
          })),
        }),
    ...(capability.limitations === undefined
      ? {}
      : {
          limitation: capability.limitations.map((limitation) => ({
            code: limitation.code,
            kind: limitation.kind,
            severity: limitation.severity,
            message: limitation.message,
            ...(limitation.affects === undefined ? {} : { affects: limitation.affects }),
          })),
        }),
    ...(capability.metadata === undefined ? {} : { metadata: capability.metadata }),
  }
}

function sessionJson(session: ServerSession): Record<string, unknown> {
  return {
    id: session.id,
    ...(session.computerId === undefined ? {} : { "computer-id": session.computerId }),
    actions: session.actions,
    "last-action-at": String(session.lastActionAt),
  }
}

function channelJson(channel: ChatChannelSummary): Record<string, unknown> {
  return {
    platform: channel.platform,
    enabled: channel.enabled,
    configured: channel.configured,
    ...(channel.connectedAt === undefined ? {} : { "connected-at": String(channel.connectedAt) }),
    ...(channel.lastMessageAt === undefined ? {} : { "last-message-at": String(channel.lastMessageAt) }),
    ...(channel.messageCount === undefined ? {} : { "message-count": channel.messageCount }),
    ...(channel.error === undefined ? {} : { error: channel.error }),
    ...(channel.owner === undefined
      ? {}
      : { owner: { provider: channel.owner.provider, id: channel.owner.id, login: channel.owner.login } }),
  }
}
