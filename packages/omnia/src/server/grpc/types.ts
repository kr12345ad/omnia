import type { ServiceDefinition } from "@grpc/grpc-js"
import { status as GrpcStatus } from "@grpc/grpc-js"

/**
 * The decoded protobuf shapes used by the official gnmi.proto.
 *
 * @grpc/proto-loader is configured with keepCase, enums as names, longs as
 * strings and oneofs enabled, so these are the exact objects the handlers see.
 * Responses use the same field names the serializer expects.
 */
export interface ProtoPathElem {
  readonly name?: string
  // gnmi.proto declares key as a map. proto-loader's representation of a map
  // may be either a plain object or the repeated Key entries depending on how
  // the descriptor was produced, so both shapes are accepted here.
  readonly key?:
    | Readonly<Record<string, string>>
    | readonly { readonly key?: string; readonly value?: string }[]
}

export interface ProtoPath {
  readonly element?: readonly string[]
  readonly origin?: string
  readonly elem?: readonly ProtoPathElem[]
  readonly target?: string
}

export interface ProtoTypedValue {
  readonly string_val?: string
  readonly int_val?: string | number
  readonly uint_val?: string | number
  readonly bool_val?: boolean
  readonly bytes_val?: Buffer | Uint8Array
  readonly float_val?: number
  readonly double_val?: number
  readonly leaflist_val?: unknown
  readonly any_val?: unknown
  readonly json_val?: Buffer | Uint8Array
  readonly json_ietf_val?: Buffer | Uint8Array
  readonly ascii_val?: string
  readonly proto_bytes?: Buffer | Uint8Array
  /** The virtual oneof discriminator emitted by proto-loader. */
  readonly value?: string
}

export interface ProtoUpdate {
  readonly path?: ProtoPath
  readonly val?: ProtoTypedValue
  readonly value?: {
    readonly value?: Buffer | Uint8Array
    readonly type?: string | number
  }
  readonly duplicates?: number
}

export interface ProtoNotification {
  readonly timestamp?: string | number
  readonly prefix?: ProtoPath
  readonly update?: readonly ProtoUpdate[]
  readonly delete?: readonly ProtoPath[]
  readonly atomic?: boolean
}

export interface ProtoGetRequest {
  readonly prefix?: ProtoPath
  readonly path?: readonly ProtoPath[]
  readonly type?: string
  readonly encoding?: string
  readonly use_models?: readonly unknown[]
}

export interface ProtoGetResponse {
  readonly notification?: readonly ProtoNotification[]
}

export interface ProtoSetRequest {
  readonly prefix?: ProtoPath
  readonly delete?: readonly ProtoPath[]
  readonly replace?: readonly ProtoUpdate[]
  readonly update?: readonly ProtoUpdate[]
  readonly union_replace?: readonly ProtoUpdate[]
}

export interface ProtoUpdateResult {
  readonly path?: ProtoPath
  readonly op?: string
  readonly timestamp?: string | number
  readonly message?: {
    readonly code?: number
    readonly message?: string
  }
}

export interface ProtoSetResponse {
  readonly prefix?: ProtoPath
  readonly response?: readonly ProtoUpdateResult[]
  readonly timestamp?: string | number
}

export interface ProtoModelData {
  readonly name?: string
  readonly organization?: string
  readonly version?: string
}

export interface ProtoCapabilityResponse {
  readonly supported_models?: readonly ProtoModelData[]
  readonly supported_encodings?: readonly string[]
  readonly gNMI_version?: string
}

export interface ProtoSubscription {
  readonly path?: ProtoPath
  readonly mode?: string
  readonly sample_interval?: string | number
  readonly suppress_redundant?: boolean
  readonly heartbeat_interval?: string | number
}

export interface ProtoSubscriptionList {
  readonly prefix?: ProtoPath
  readonly subscription?: readonly ProtoSubscription[]
  readonly mode?: string
  readonly allow_aggregation?: boolean
  readonly use_models?: readonly unknown[]
  readonly encoding?: string
  readonly updates_only?: boolean
}

export interface ProtoSubscribeRequest {
  readonly subscribe?: ProtoSubscriptionList
  readonly poll?: Record<string, never>
  readonly extension?: readonly unknown[]
}

export interface ProtoSubscribeResponse {
  readonly update?: ProtoNotification
  readonly sync_response?: boolean
  readonly error?: {
    readonly code?: number
    readonly message?: string
  }
}

export interface GnmiServiceDefinition extends ServiceDefinition {}

export class GrpcError extends Error {
  constructor(
    readonly code: GrpcStatus,
    message: string,
  ) {
    super(message)
    this.name = "GrpcError"
  }
}
