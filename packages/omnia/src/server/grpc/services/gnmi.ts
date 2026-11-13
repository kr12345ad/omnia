import type { ServerDuplexStream, ServerUnaryCall, sendUnaryData } from "@grpc/grpc-js"
import { status as GrpcStatus } from "@grpc/grpc-js"
import type { SecurityRecord } from "../../../security/journal"
import { PERMISSION_STATES, isOmniaScope, type OmniaScope, type PermissionState } from "../../permissions"
import {
  authorizePath,
  authorizeSetPath,
  type GrpcPrincipal,
} from "../auth"
import { formatModelPath, isKnownPath, modelPathString, parseModelPath, pathKind, pathScopeName, type ModelPath } from "../paths"
import { resolvePath, type GnmiAccess, type GnmiDataType, type GnmiStateSource } from "../state"
import type { SubscriptionManager } from "../subscriptions"
import type {
  ProtoCapabilityResponse,
  ProtoGetRequest,
  ProtoGetResponse,
  ProtoNotification,
  ProtoPath,
  ProtoSetRequest,
  ProtoSetResponse,
  ProtoSubscribeRequest,
  ProtoSubscribeResponse,
  ProtoTypedValue,
  ProtoUpdate,
  ProtoUpdateResult,
} from "../types"
import { GrpcError } from "../types"
import { jsonIetfValue, readStringValue } from "../values"

export const GNMI_VERSION = "0.10.0"
export const GNMI_MODEL = {
  name: "omnia",
  organization: "Omnia",
  version: "0.1.0",
} as const

export interface GnmiServiceDeps {
  readonly source: GnmiStateSource
  readonly subscriptions: SubscriptionManager
  readonly setPermission: (scope: OmniaScope, state: PermissionState) => void
  /** The paid chat capability, checked before any chat state is read. */
  readonly chatCapability: (principal: GrpcPrincipal) => Promise<{ readonly status: number } | undefined>
  readonly now: () => number
  readonly serverId: string
  readonly audit: (record: SecurityRecord) => void
}

export interface GnmiHandlers {
  readonly Capabilities: (
    call: ServerUnaryCall<Record<string, never>, ProtoCapabilityResponse>,
    callback: sendUnaryData<ProtoCapabilityResponse>,
  ) => void
  readonly Get: (
    call: ServerUnaryCall<ProtoGetRequest, ProtoGetResponse>,
    callback: sendUnaryData<ProtoGetResponse>,
    access: GnmiAccess,
    principal: GrpcPrincipal,
  ) => Promise<void>
  readonly Set: (
    call: ServerUnaryCall<ProtoSetRequest, ProtoSetResponse>,
    callback: sendUnaryData<ProtoSetResponse>,
    access: GnmiAccess,
    principal: GrpcPrincipal,
  ) => Promise<void>
  readonly Subscribe: (
    call: ServerDuplexStream<ProtoSubscribeRequest, ProtoSubscribeResponse>,
    access: GnmiAccess,
    principal: GrpcPrincipal,
  ) => void
}

export function createGnmiHandlers(deps: GnmiServiceDeps): GnmiHandlers {
  return {
    Capabilities: (_call, callback) => {
      callback(null, {
        supported_models: [{ ...GNMI_MODEL }],
        // JSON_IETF is the only encoding this implementation emits. Advertising
        // JSON, PROTO or ASCII here would promise behavior Get and Subscribe do
        // not implement.
        supported_encodings: ["JSON_IETF"],
        gNMI_version: GNMI_VERSION,
      })
    },

    Get: async (call, callback, access, principal) => {
      if (call.request.encoding !== undefined && call.request.encoding !== "JSON_IETF") {
        throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, `Unsupported encoding ${call.request.encoding}; use JSON_IETF.`)
      }
      if (!modelsSupported(call.request.use_models)) {
        throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, `Unsupported model in use_models. Omnia publishes ${GNMI_MODEL.name}.`)
      }
      const type = dataType(call.request.type)
      const requested = call.request.path ?? []
      // An empty path list means the prefix itself (the root when no prefix is
      // given), matching the gNMI convention for a whole-tree Get. A client may
      // serialize an omitted root as an empty Path message rather than omitting
      // prefix entirely, so both forms resolve to /omnia.
      const prefix = call.request.prefix
      const root =
        prefix === undefined
          ? { origin: "omnia", elem: [{ name: "omnia" }] }
          : isEmptyPath(prefix)
            ? { ...prefix, elem: [{ name: "omnia" }] }
            : prefix
      const paths =
        requested.length === 0
          ? [parseModelPath(undefined, root)]
          : requested.map((path) => parseModelPath(prefix, path))

      for (const path of paths) {
        if (!isKnownPath(path)) {
          throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, `Unknown Omnia model path ${modelPathString(path)}.`)
        }
        if (!authorizePath(path, access, deps.source)) {
          throw new GrpcError(GrpcStatus.PERMISSION_DENIED, `Access to ${modelPathString(path)} is not permitted.`)
        }
      }

      // Chat channels are a paid capability. A concrete chat path is refused
      // with the same 402/503 distinction HTTP uses; the root hides the chat
      // subtree instead of failing every other readable leaf with it.
      const chat = await chatCapability(paths, access, principal, deps)
      if (chat !== undefined && paths.some((path) => pathKind(path) === "chat")) throw chatError(chat)
      const readAccess = chat === undefined ? access : { ...access, chat: false }

      const updates = []
      for (const path of paths) {
        const value = await resolvePath(path, deps.source, readAccess, type)
        if (value === undefined) continue
        updates.push({ path: formatModelPath(path), val: jsonIetfValue(value) })
      }
      callback(null, {
        notification: [{ timestamp: String(deps.now() * 1_000_000), update: updates }],
      })
    },

    Set: async (call, callback, access, principal) => {
      const update = call.request.update ?? []
      const replace = call.request.replace ?? []
      const unionReplace = call.request.union_replace ?? []
      const deleted = call.request.delete ?? []
      if (update.length + replace.length + unionReplace.length + deleted.length === 0) {
        throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, "A SetRequest must contain at least one update, replace or delete.")
      }
      if (unionReplace.length > 0) {
        throw new GrpcError(GrpcStatus.UNIMPLEMENTED, "union_replace is not part of the Omnia gNMI subset.")
      }
      if (deleted.length > 0) {
        throw new GrpcError(
          GrpcStatus.UNIMPLEMENTED,
          "Deleting configuration is not supported; set the permission state to its default instead.",
        )
      }

      const changes = [
        ...replace.map((entry) => readChange(entry, call.request.prefix, "REPLACE")),
        ...update.map((entry) => readChange(entry, call.request.prefix, "UPDATE")),
      ]
      for (const change of changes) {
        if (!authorizeSetPath(change.path, access)) {
          throw new GrpcError(GrpcStatus.PERMISSION_DENIED, `Configuration at ${modelPathString(change.path)} is not writable.`)
        }
      }
      // Validate every leaf before applying any of them, so a bad second update
      // cannot leave the server half-configured. Audit before mutation: a
      // journal write failure must refuse the change rather than apply it
      // without a security record.
      for (const change of changes) {
        deps.audit({
          type: "grpc.gnmi.set",
          at: deps.now(),
          serverId: deps.serverId,
          method: "Set",
          route: modelPathString(change.path),
          actor: principal.actor,
        })
      }
      for (const change of changes) deps.setPermission(change.scope, change.state)
      const at = String(deps.now() * 1_000_000)
      const response: ProtoUpdateResult[] = changes.map((change) => ({
        path: formatModelPath(change.path),
        op: change.op,
      }))
      callback(null, { response, timestamp: at })
    },

    Subscribe: (call, access, principal) => {
      deps.subscriptions.open(call, principal, access)
    },
  }
}

function isEmptyPath(path: ProtoPath): boolean {
  return (path.elem?.length ?? 0) === 0 && (path.element?.length ?? 0) === 0
}

async function chatCapability(
  paths: readonly ModelPath[],
  access: GnmiAccess,
  principal: GrpcPrincipal,
  deps: GnmiServiceDeps,
): Promise<{ readonly status: number } | undefined> {
  if (!access.chat) return undefined
  if (!paths.some((path) => pathKind(path) === "root" || pathKind(path) === "chat")) return undefined
  return deps.chatCapability(principal)
}

function chatError(refusal: { readonly status: number }): GrpcError {
  if (refusal.status === 402) {
    return new GrpcError(
      GrpcStatus.PERMISSION_DENIED,
      "The chat_channels capability is not enabled for this account.",
    )
  }
  return new GrpcError(
    GrpcStatus.UNAVAILABLE,
    "The chat_channels entitlement could not be confirmed, so chat state was not served.",
  )
}

function readChange(
  entry: ProtoUpdate,
  prefix: ProtoPath | undefined,
  op: "UPDATE" | "REPLACE",
): { path: ModelPath; scope: OmniaScope; state: PermissionState; op: string } {
  if (entry.path === undefined) throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, `A ${op} entry needs a path.`)
  const path = parseModelPath(prefix, entry.path)
  if (!isKnownPath(path) || path.elements[1]?.name !== "config") {
    throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, `Configuration at ${modelPathString(path)} is not modeled.`)
  }
  if (path.elements.at(-1)?.name !== "state") {
    throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, "Only the permission state leaf is writable.")
  }
  const scope = pathScopeName(path)
  if (scope === undefined) throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, "The permission scope name is required.")
  if (!isOmniaScope(scope)) throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, `Unknown permission scope ${scope}.`)
  const state = readStringValue(entry.val)
  if (state === undefined || !(PERMISSION_STATES as readonly string[]).includes(state)) {
    throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, `Unsupported permission state ${state ?? ""}.`)
  }
  return { path, scope, state: state as PermissionState, op }
}

function modelsSupported(models: readonly unknown[] | undefined): boolean {
  if (models === undefined || models.length === 0) return true
  return models.every((model) => {
    if (typeof model !== "object" || model === null) return false
    return (model as { name?: unknown }).name === GNMI_MODEL.name
  })
}

function dataType(value: string | undefined): GnmiDataType {
  if (value === undefined || value === "ALL") return "ALL"
  if (value === "CONFIG" || value === "STATE" || value === "OPERATIONAL") return value
  throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, `Unsupported GetRequest type ${value}.`)
}

export function notificationValue(value: unknown): ProtoTypedValue {
  return jsonIetfValue(value)
}

export function emptyNotification(timestamp: number): ProtoNotification {
  return { timestamp: String(timestamp * 1_000_000) }
}
