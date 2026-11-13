import type { ServerDuplexStream, ServerUnaryCall, ServiceDefinition, UntypedServiceImplementation } from "@grpc/grpc-js"
import {
  Server,
  ServerCredentials,
  ServerInterceptingCall,
  status as GrpcStatus,
  type ServerInterceptor,
  type ServerMethodDefinition,
  type sendUnaryData,
} from "@grpc/grpc-js"
import { loadFileDescriptorSetFromBuffer, type PackageDefinition } from "@grpc/proto-loader"
import type { SecurityJournal, SecurityRecord } from "../../security/journal"
import type { OmniaScope, PermissionState, PermissionManager } from "../permissions"
import type { EventBus } from "../events"
import type { RemoteRegistry } from "../remote"
import type { ComputerManager } from "../computers"
import { authenticate, createAccess, type GrpcAuth, type GrpcPrincipal } from "./auth"
import { GNMI_DESCRIPTOR_BASE64 } from "./generated/descriptor"
import { ModelPathError } from "./paths"
import type { GnmiAccess, GnmiStateSource } from "./state"
import type { ProtoSubscribeRequest, ProtoSubscribeResponse } from "./types"
import { GrpcError } from "./types"
import { createGnmiHandlers } from "./services/gnmi"
import { createComputerHandlers } from "./services/computer"
import { SubscriptionManager } from "./subscriptions"

export interface GrpcTlsOptions {
  /** PEM-encoded server certificate chain, not a file path. */
  readonly cert: string | Buffer
  /** PEM-encoded private key matching cert, not a file path. */
  readonly key: string | Buffer
  /** PEM root certificate used to verify a client certificate, when required. */
  readonly rootCert?: string | Buffer
  readonly clientCertRequired?: boolean
}

export interface GrpcServerOptions {
  readonly host?: string
  readonly port?: number
  /** Required to bind off loopback. Authentication still applies to every call. */
  readonly allowRemote?: boolean
  readonly token: string
  readonly auth: GrpcAuth
  readonly remote: RemoteRegistry
  readonly source: GnmiStateSource
  /** The paid chat capability, applied before any chat state is read. */
  readonly chatCapability?: (principal: GrpcPrincipal) => Promise<{ readonly status: number } | undefined>
  readonly computers: ComputerManager
  readonly permissions: PermissionManager
  readonly events: EventBus
  readonly serverId: string
  readonly now: () => number
  readonly audit: SecurityJournal
  readonly tls?: GrpcTlsOptions
}

export interface GrpcServerHandle {
  readonly url: string
  readonly host: string
  readonly port: number
  readonly activeSubscriptions: () => number
  readonly stop: () => Promise<void>
}

const LOOPBACK = ["127.0.0.1", "localhost", "::1"]
const LOADER_OPTIONS = {
  keepCase: true,
  longs: String,
  enums: String,
  oneofs: true,
  defaults: false,
} as const

export async function startGrpcServer(options: GrpcServerOptions): Promise<GrpcServerHandle> {
  // Accept the conventional bracket form but bind one canonical host.
  const host = (options.host ?? "127.0.0.1").replace(/^\[(.*)\]$/, "$1")
  if (!LOOPBACK.includes(host)) {
    if (options.allowRemote !== true) {
      throw new Error("The Omnia gRPC server must bind to loopback unless allowRemote is explicitly enabled.")
    }
    if (options.tls === undefined) {
      // A remote bearer would otherwise cross the network in cleartext. The
      // explicit allowRemote switch opts into a remote listener, not into
      // exposing the operator token to every hop on the path.
      throw new Error("The Omnia gRPC server requires TLS when binding off loopback.")
    }
  }
  if (options.token.trim().length === 0) throw new Error("The Omnia gRPC server requires a non-empty bearer token.")

  const chatCapability = options.chatCapability ?? (async () => undefined)
  const subscriptions = new SubscriptionManager({
    events: options.events,
    source: options.source,
    now: options.now,
    chatCapability,
    // A live stream may outlast the credential that opened it. Each flush
    // rechecks, so signing out or revoking a client token stops delivery
    // instead of leaving a revoked identity with a permanent read stream.
    authorized: (principal) =>
      principal.kind === "operator" || options.auth.isClientToken(principal.token),
  })
  const gnmi = createGnmiHandlers({
    source: options.source,
    subscriptions,
    chatCapability,
    setPermission: (scope, state) => {
      options.permissions.set(scope, state)
      options.events.emit("permission.changed", { data: { scope, state } })
    },
    now: options.now,
    serverId: options.serverId,
    audit: (record) => options.audit.append(record),
  })
  const computerService = createComputerHandlers({
    computers: options.computers,
    source: options.source,
    now: options.now,
    serverId: options.serverId,
    audit: (record) => options.audit.append(record),
  })

  const server = new Server({ interceptors: [authenticationInterceptor(options)] })
  const definitions = loadDefinitions()
  server.addService(
    definitions.gnmi,
    {
      Capabilities: gnmi.Capabilities,
      Get: unary(options, gnmi.Get),
      Set: unary(options, gnmi.Set),
      Subscribe: (call: ServerDuplexStream<ProtoSubscribeRequest, ProtoSubscribeResponse>) => {
        const principal = authenticate(call.metadata, options.token, options.auth)
        // The interceptor rejects unauthenticated metadata before this handler
        // runs. Keeping the check here too means a future interceptor change
        // cannot accidentally expose a streaming method.
        if (principal === undefined) return
        gnmi.Subscribe(call, createAccess(principal, options.remote), principal)
      },
    } as unknown as UntypedServiceImplementation,
  )
  server.addService(
    definitions.computer,
    {
      ListComputers: unary(options, computerService.ListComputers),
      GetComputer: unary(options, computerService.GetComputer),
      ConnectComputer: unary(options, computerService.ConnectComputer),
      DisconnectComputer: unary(options, computerService.DisconnectComputer),
    } as unknown as UntypedServiceImplementation,
  )
  server.addService(
    definitions.health,
    { Check: unary(options, computerService.Check) } as unknown as UntypedServiceImplementation,
  )

  if (options.tls?.clientCertRequired === true && options.tls.rootCert === undefined) {
    throw new Error("A gRPC TLS configuration that requires client certificates needs a rootCert.")
  }
  const credentials =
    options.tls === undefined
      ? ServerCredentials.createInsecure()
      : ServerCredentials.createSsl(
          options.tls.rootCert === undefined ? null : Buffer.from(options.tls.rootCert),
          [{ private_key: Buffer.from(options.tls.key), cert_chain: Buffer.from(options.tls.cert) }],
          options.tls.clientCertRequired === true,
        )

  let port: number
  try {
    port = await new Promise<number>((resolve, reject) => {
      const address = `${host.includes(":") ? `[${host}]` : host}:${options.port ?? 0}`
      server.bindAsync(address, credentials, (error, boundPort) => {
        if (error !== null) {
          reject(error)
          return
        }
        if (boundPort === 0) {
          reject(new Error("The Omnia gRPC server did not report a bound port."))
          return
        }
        resolve(boundPort)
      })
    })
  } catch (error) {
    await subscriptions.closeAll()
    server.forceShutdown()
    throw error
  }

  return {
    url: `${options.tls === undefined ? "grpc" : "grpcs"}://${host.includes(":") ? `[${host}]` : host}:${port}`,
    host,
    port,
    activeSubscriptions: () => subscriptions.size,
    stop: async () => {
      await subscriptions.closeAll()
      await new Promise<void>((resolve) => {
        let settled = false
        const settle = () => {
          if (settled) return
          settled = true
          resolve()
        }
        server.tryShutdown(() => settle())
        const timer = setTimeout(() => {
          server.forceShutdown()
          settle()
        }, 2_000)
        timer.unref?.()
      })
    },
  }
}

function loadDefinitions(): {
  readonly gnmi: ServiceDefinition
  readonly computer: ServiceDefinition
  readonly health: ServiceDefinition
} {
  const packageDefinition: PackageDefinition = loadFileDescriptorSetFromBuffer(
    Buffer.from(GNMI_DESCRIPTOR_BASE64, "base64"),
    LOADER_OPTIONS,
  )
  return {
    gnmi: packageDefinition["gnmi.gNMI"] as unknown as ServiceDefinition,
    computer: packageDefinition["omnia.v1.ComputerService"] as unknown as ServiceDefinition,
    health: packageDefinition["omnia.v1.HealthService"] as unknown as ServiceDefinition,
  }
}

function authenticationInterceptor(options: GrpcServerOptions): ServerInterceptor {
  return (method: ServerMethodDefinition<unknown, unknown>, call) =>
    new ServerInterceptingCall(call, {
      start(next) {
        next({
          onReceiveMetadata(metadata, nextMetadata) {
            if (authenticate(metadata, options.token, options.auth) !== undefined) {
              nextMetadata(metadata)
              return
            }
            options.audit.append(authFailure(method.path, call.getPeer(), options))
            call.sendStatus({ code: GrpcStatus.UNAUTHENTICATED, details: "Unauthorized." })
          },
        })
      },
    })
}

function unary<Request, Response>(
  options: GrpcServerOptions,
  handler: (
    call: ServerUnaryCall<Request, Response>,
    callback: sendUnaryData<Response>,
    access: GnmiAccess,
    principal: GrpcPrincipal,
  ) => void | Promise<void>,
) {
  return (call: ServerUnaryCall<Request, Response>, callback: sendUnaryData<Response>) => {
    const principal = authenticate(call.metadata, options.token, options.auth)
    if (principal === undefined) {
      // The interceptor normally rejects this before the handler runs. Treat a
      // missing principal as a hard failure rather than falling back to a
      // permissive access object.
      callback({ code: GrpcStatus.UNAUTHENTICATED, details: "Unauthorized." })
      return
    }
    void Promise.resolve(handler(call, callback, createAccess(principal, options.remote), principal)).catch((error: unknown) => {
      callback(errorStatus(error))
    })
  }
}

function authFailure(path: string, peer: string, options: GrpcServerOptions): SecurityRecord {
  return {
    type: "grpc.auth.failed",
    at: options.now(),
    serverId: options.serverId,
    method: path,
    status: GrpcStatus.UNAUTHENTICATED,
    address: peer,
  }
}

function errorStatus(error: unknown): { code: GrpcStatus; details: string } {
  if (error instanceof GrpcError) return { code: error.code, details: error.message }
  if (error instanceof ModelPathError) return { code: GrpcStatus.INVALID_ARGUMENT, details: error.message }
  if (error instanceof Error) return { code: GrpcStatus.INTERNAL, details: error.message }
  return { code: GrpcStatus.INTERNAL, details: "The gRPC request failed." }
}

export type { OmniaScope, PermissionState }
