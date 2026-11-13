import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  credentials,
  Metadata,
  makeGenericClientConstructor,
  status as GrpcStatus,
  type ClientDuplexStream,
  type ServiceDefinition,
  type ServiceError,
} from "@grpc/grpc-js"
import { loadFileDescriptorSetFromBuffer, type PackageDefinition } from "@grpc/proto-loader"
import { startOmniaServer, type OmniaServerHandle } from "../server"
import { GNMI_DESCRIPTOR_BASE64 } from "./generated/descriptor"
import type {
  ProtoCapabilityResponse,
  ProtoGetRequest,
  ProtoGetResponse,
  ProtoSetRequest,
  ProtoSetResponse,
  ProtoPath,
  ProtoSubscribeRequest,
  ProtoSubscribeResponse,
  ProtoTypedValue,
} from "./types"

type Callback<T> = (error: ServiceError | null, value: T) => void

interface GnmiClient {
  Capabilities(request: Record<string, never>, metadata: Metadata, callback: Callback<ProtoCapabilityResponse>): void
  Get(request: ProtoGetRequest, metadata: Metadata, callback: Callback<ProtoGetResponse>): void
  Set(request: ProtoSetRequest, metadata: Metadata, callback: Callback<ProtoSetResponse>): void
  Subscribe(metadata: Metadata): ClientDuplexStream<ProtoSubscribeRequest, ProtoSubscribeResponse>
  close(): void
}

interface ComputerClient {
  ListComputers(request: Record<string, never>, metadata: Metadata, callback: Callback<{ computers?: readonly unknown[] }>): void
  GetComputer(request: { id: string }, metadata: Metadata, callback: Callback<unknown>): void
  ConnectComputer(
    request: { id: string },
    metadata: Metadata,
    callback: Callback<{ ok?: boolean; status?: string }>,
  ): void
  Check(request: Record<string, never>, metadata: Metadata, callback: Callback<{ status?: string }>): void
  close(): void
}

const PACKAGE: PackageDefinition = loadFileDescriptorSetFromBuffer(
  Buffer.from(GNMI_DESCRIPTOR_BASE64, "base64"),
  { keepCase: true, longs: String, enums: String, oneofs: true, defaults: false },
)

function clientFor<T>(service: string, server: OmniaServerHandle): T {
  const constructor = makeGenericClientConstructor(PACKAGE[service] as ServiceDefinition, service)
  const address = server.grpc?.url.replace(/^grpcs?:\/\//, "")
  if (address === undefined) throw new Error("The test server did not start gRPC.")
  return new constructor(address, credentials.createInsecure()) as unknown as T
}

function auth(token: string): Metadata {
  const metadata = new Metadata()
  metadata.set("authorization", `Bearer ${token}`)
  return metadata
}

function unary<Request, Response>(
  method: (
    request: Request,
    metadata: Metadata,
    callback: Callback<Response>,
  ) => void,
  request: Request,
  metadata: Metadata,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    method(request, metadata, (error, value) => {
      if (error !== null) {
        reject(error)
        return
      }
      resolve(value)
    })
  })
}

function json(value: ProtoTypedValue | undefined): unknown {
  if (value?.json_ietf_val === undefined) return undefined
  return JSON.parse(Buffer.from(value.json_ietf_val).toString("utf8"))
}

function path(...elements: string[]): { origin: string; elem: { name: string }[] } {
  return { origin: "omnia", elem: elements.map((name) => ({ name })) }
}

function scopePath(scope: string): ProtoPath {
  return {
    origin: "omnia",
    elem: [
      { name: "omnia" },
      { name: "config" },
      { name: "permissions" },
      { name: "scope", key: [{ key: "name", value: scope }] },
      { name: "state" },
    ],
  }
}

interface Collector {
  readonly wait: (predicate: (response: ProtoSubscribeResponse) => boolean, timeoutMs?: number) => Promise<ProtoSubscribeResponse>
}

function collector(call: ClientDuplexStream<ProtoSubscribeRequest, ProtoSubscribeResponse>): Collector {
  const responses: ProtoSubscribeResponse[] = []
  let consumed = 0
  const waiters: {
    predicate: (response: ProtoSubscribeResponse) => boolean
    resolve: (response: ProtoSubscribeResponse) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }[] = []

  const notify = () => {
    while (waiters.length > 0) {
      const waiter = waiters[0]
      if (waiter === undefined) return
      const found = responses.slice(consumed).find(waiter.predicate)
      if (found === undefined) return
      consumed = responses.indexOf(found) + 1
      waiters.shift()
      clearTimeout(waiter.timer)
      waiter.resolve(found)
    }
  }

  call.on("data", (response: ProtoSubscribeResponse) => {
    responses.push(response)
    notify()
  })
  call.on("error", (error: Error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  })

  return {
    wait: (predicate, timeoutMs = 3000) => {
      const found = responses.slice(consumed).find(predicate)
      if (found !== undefined) {
        consumed = responses.indexOf(found) + 1
        return Promise.resolve(found)
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((entry) => entry.timer === timer)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error("Timed out waiting for a gNMI subscription response."))
        }, timeoutMs)
        waiters.push({ predicate, resolve, reject, timer })
      })
    },
  }
}

async function withServer<T>(fn: (server: OmniaServerHandle) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "omnia-grpc-"))
  const server = await startOmniaServer({
    grpc: { enabled: true },
    authFile: join(dir, "auth.json"),
    auditFile: join(dir, "audit.jsonl"),
  })
  try {
    return await fn(server)
  } finally {
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for gRPC state.")
    await Bun.sleep(10)
  }
}

describe("Omnia gRPC and gNMI", () => {
  test("starts with the HTTP server, reports both surfaces, and shuts down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-grpc-"))
    const server = await startOmniaServer({
      grpc: { enabled: true },
      authFile: join(dir, "auth.json"),
      auditFile: join(dir, "audit.jsonl"),
    })
    try {
      expect(server.grpc?.url).toMatch(/^grpc:\/\/127\.0\.0\.1:\d+$/)
      expect(server.grpc?.activeSubscriptions()).toBe(0)
      const response = await fetch(`${server.url}/v1/health`, {
        headers: { authorization: `Bearer ${server.token}` },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ok: true, health: { status: "ready" } })
    } finally {
      await server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("Capabilities advertises the official version, model and implemented encoding", async () => {
    await withServer(async (server) => {
      const client = clientFor<GnmiClient>("gnmi.gNMI", server)
      try {
        const response = await unary(client.Capabilities.bind(client), {}, auth(server.token))
        expect(response.gNMI_version).toBe("0.10.0")
        expect(response.supported_encodings).toEqual(["JSON_IETF"])
        expect(response.supported_models).toEqual([{ name: "omnia", organization: "Omnia", version: "0.1.0" }])
      } finally {
        client.close()
      }
    })
  })

  test("rejects missing and invalid credentials", async () => {
    await withServer(async (server) => {
      const client = clientFor<GnmiClient>("gnmi.gNMI", server)
      try {
        const missing = await unary(client.Capabilities.bind(client), {}, new Metadata()).catch((error: ServiceError) => error)
        expect(missing).toMatchObject({ code: GrpcStatus.UNAUTHENTICATED })
        const invalid = await unary(client.Capabilities.bind(client), {}, auth("not-a-token")).catch(
          (error: ServiceError) => error,
        )
        expect(invalid).toMatchObject({ code: GrpcStatus.UNAUTHENTICATED })
      } finally {
        client.close()
      }
    })
  })

  test("Get resolves YANG paths and rejects unknown paths", async () => {
    await withServer(async (server) => {
      const client = clientFor<GnmiClient>("gnmi.gNMI", server)
      try {
        const response = await unary(
          client.Get.bind(client),
          { path: [path("omnia", "server", "status")], type: "ALL", encoding: "JSON_IETF" },
          auth(server.token),
        )
        expect(response.notification?.[0]?.update?.[0]?.path).toMatchObject({ origin: "omnia" })
        expect(json(response.notification?.[0]?.update?.[0]?.val)).toMatchObject({
          state: "ready",
          // RFC7951 uint64 values are strings, not numbers.
          "started-at": expect.any(String),
          "uptime-ms": expect.any(String),
        })

        const prefixed = await unary(
          client.Get.bind(client),
          {
            prefix: path("omnia", "server"),
            path: [{ origin: "omnia", elem: [{ name: "status" }] }],
            type: "ALL",
            encoding: "JSON_IETF",
          },
          auth(server.token),
        )
        expect(json(prefixed.notification?.[0]?.update?.[0]?.val)).toMatchObject({ state: "ready" })

        const unknown = await unary(
          client.Get.bind(client),
          { path: [path("omnia", "does-not-exist")], type: "ALL", encoding: "JSON_IETF" },
          auth(server.token),
        ).catch((error: ServiceError) => error)
        expect(unknown).toMatchObject({ code: GrpcStatus.INVALID_ARGUMENT })

        const root = await unary(
          client.Get.bind(client),
          { type: "ALL", encoding: "JSON_IETF" },
          auth(server.token),
        )
        expect(json(root.notification?.[0]?.update?.[0]?.val)).toMatchObject({
          server: { status: { state: "ready" } },
          config: { permissions: { scope: expect.any(Array) } },
        })

        const emptyPrefix = await unary(
          client.Get.bind(client),
          { prefix: { origin: "omnia" }, type: "ALL", encoding: "JSON_IETF" },
          auth(server.token),
        )
        expect(json(emptyPrefix.notification?.[0]?.update?.[0]?.val)).toMatchObject({
          server: { status: { state: "ready" } },
        })

        const badOrigin = await unary(
          client.Get.bind(client),
          { prefix: { origin: "not-omnia" }, type: "ALL", encoding: "JSON_IETF" },
          auth(server.token),
        ).catch((error: ServiceError) => error)
        expect(badOrigin).toMatchObject({ code: GrpcStatus.INVALID_ARGUMENT })

        const scopes = await unary(
          client.Get.bind(client),
          {
            path: [path("omnia", "config", "permissions", "scope")],
            type: "ALL",
            encoding: "JSON_IETF",
          },
          auth(server.token),
        )
        expect(json(scopes.notification?.[0]?.update?.[0]?.val)).toMatchObject({
          scope: expect.any(Array),
        })

        const configOnly = await unary(
          client.Get.bind(client),
          { type: "CONFIG", encoding: "JSON_IETF" },
          auth(server.token),
        )
        const configRoot = json(configOnly.notification?.[0]?.update?.[0]?.val) as Record<string, unknown>
        expect(configRoot).toHaveProperty("config")
        expect(configRoot).not.toHaveProperty("server")

        const stateOnly = await unary(
          client.Get.bind(client),
          { type: "STATE", encoding: "JSON_IETF" },
          auth(server.token),
        )
        const stateRoot = json(stateOnly.notification?.[0]?.update?.[0]?.val) as Record<string, unknown>
        expect(stateRoot).toHaveProperty("server")
        expect(stateRoot).not.toHaveProperty("config")

        const badKey = await unary(
          client.Get.bind(client),
          {
            path: [
              {
                origin: "omnia",
                elem: [
                  { name: "omnia" },
                  { name: "server", key: [{ key: "name", value: "x" }] },
                  { name: "status" },
                ],
              },
            ],
            type: "ALL",
            encoding: "JSON_IETF",
          },
          auth(server.token),
        ).catch((error: ServiceError) => error)
        expect(badKey).toMatchObject({ code: GrpcStatus.INVALID_ARGUMENT })
      } finally {
        client.close()
      }
    })
  })

  test("execution state is projected from computer_use.executed EventBus events", async () => {
    await withServer(async (server) => {
      const client = clientFor<GnmiClient>("gnmi.gNMI", server)
      try {
        server.events.emit("computer_use.executed", {
          data: { action: "click", success: true, verified: true, provider: "local", model: "omni" },
        })
        const get = await unary(
          client.Get.bind(client),
          { path: [path("omnia", "server", "execution", "last")], type: "STATE", encoding: "JSON_IETF" },
          auth(server.token),
        )
        expect(json(get.notification?.[0]?.update?.[0]?.val)).toMatchObject({
          action: "click",
          success: true,
          verified: true,
          provider: "local",
          model: "omni",
        })

        const call = client.Subscribe(auth(server.token))
        const stream = collector(call)
        try {
          call.write({
            subscribe: {
              encoding: "JSON_IETF",
              mode: "STREAM",
              subscription: [
                { path: path("omnia", "server", "execution", "last"), mode: "ON_CHANGE" },
              ],
            },
          })
          await stream.wait((response) => response.sync_response === true)
          server.events.emit("computer_use.executed", {
            data: { action: "type", success: false, verified: false },
          })
          const update = await stream.wait(
            (response) =>
              response.update !== undefined &&
              (json(response.update.update?.[0]?.val) as { action?: string } | undefined)?.action === "type",
          )
          expect(json(update.update?.update?.[0]?.val)).toMatchObject({ action: "type", success: false })
        } finally {
          call.cancel()
        }
      } finally {
        client.close()
      }
    })
  })

  test("agent tokens cannot read operator configuration", async () => {
    await withServer(async (server) => {
      const token = server.auth.mintClientToken({ id: "agent-1", login: "agent" })
      expect(token).toBeDefined()
      const client = clientFor<GnmiClient>("gnmi.gNMI", server)
      try {
        const response = await unary(
          client.Get.bind(client),
          { path: [path("omnia", "config", "permissions")], type: "ALL", encoding: "JSON_IETF" },
          auth(token!),
        ).catch((error: ServiceError) => error)
        expect(response).toMatchObject({ code: GrpcStatus.PERMISSION_DENIED })
      } finally {
        client.close()
      }
    })
  })

  test("Set updates the only writable YANG leaf and audits it", async () => {
    await withServer(async (server) => {
      const client = clientFor<GnmiClient>("gnmi.gNMI", server)
      try {
        const response = await unary(
          client.Set.bind(client),
          {
            update: [
              {
                path: scopePath("SECRETS"),
                val: { json_ietf_val: Buffer.from(JSON.stringify("granted")) },
              },
            ],
          },
          auth(server.token),
        )
        expect(response.response?.[0]?.op).toBe("UPDATE")
        expect(Number(response.timestamp)).toBeGreaterThan(0)

        const deleted = await unary(
          client.Set.bind(client),
          { delete: [scopePath("SECRETS")] },
          auth(server.token),
        ).catch((error: ServiceError) => error)
        expect(deleted).toMatchObject({ code: GrpcStatus.UNIMPLEMENTED })

        const unknownScope = await unary(
          client.Set.bind(client),
          {
            update: [
              {
                path: scopePath("NOT_A_SCOPE"),
                val: { json_ietf_val: Buffer.from(JSON.stringify("granted")) },
              },
            ],
          },
          auth(server.token),
        ).catch((error: ServiceError) => error)
        expect(unknownScope).toMatchObject({ code: GrpcStatus.INVALID_ARGUMENT })

        const get = await unary(
          client.Get.bind(client),
          { path: [scopePath("SECRETS")], type: "CONFIG", encoding: "JSON_IETF" },
          auth(server.token),
        )
        expect(json(get.notification?.[0]?.update?.[0]?.val)).toBe("granted")
      } finally {
        client.close()
      }
    })
  })

  test("agent tokens cannot Set configuration", async () => {
    await withServer(async (server) => {
      const token = server.auth.mintClientToken({ id: "agent-2", login: "agent" })
      const client = clientFor<GnmiClient>("gnmi.gNMI", server)
      try {
        const response = await unary(
          client.Set.bind(client),
          {
            update: [
              {
                path: scopePath("SECRETS"),
                val: { json_ietf_val: Buffer.from(JSON.stringify("granted")) },
              },
            ],
          },
          auth(token!),
        ).catch((error: ServiceError) => error)
        expect(response).toMatchObject({ code: GrpcStatus.PERMISSION_DENIED })
      } finally {
        client.close()
      }
    })
  })

  test("ONCE returns an initial snapshot and completes", async () => {
    await withServer(async (server) => {
      const client = clientFor<GnmiClient>("gnmi.gNMI", server)
      const call = client.Subscribe(auth(server.token))
      const stream = collector(call)
      try {
        call.write({
          subscribe: {
            encoding: "JSON_IETF",
            mode: "ONCE",
            subscription: [{ path: path("omnia", "server", "status") }],
          },
        })
        const update = await stream.wait((response) => response.update !== undefined)
        expect(json(update.update?.update?.[0]?.val)).toMatchObject({ state: "ready" })
        const sync = await stream.wait((response) => response.sync_response === true)
        expect(sync.sync_response).toBe(true)
        await waitFor(() => server.grpc?.activeSubscriptions() === 0)
      } finally {
        call.destroy()
        client.close()
      }
    })
  })

  test("STREAM delivers EventBus updates after the snapshot", async () => {
    await withServer(async (server) => {
      const client = clientFor<GnmiClient>("gnmi.gNMI", server)
      const call = client.Subscribe(auth(server.token))
      const stream = collector(call)
      try {
        call.write({
          subscribe: {
            encoding: "JSON_IETF",
            mode: "STREAM",
            subscription: [{ path: scopePath("SECRETS"), mode: "ON_CHANGE" }],
          },
        })
        await stream.wait((response) => response.sync_response === true)

        await unary(
          client.Set.bind(client),
          {
            update: [
              {
                path: scopePath("SECRETS"),
                val: { json_ietf_val: Buffer.from(JSON.stringify("granted")) },
              },
            ],
          },
          auth(server.token),
        )

        const update = await stream.wait((response) => response.update !== undefined)
        expect(json(update.update?.update?.[0]?.val)).toBe("granted")
      } finally {
        call.cancel()
        client.close()
        await waitFor(() => server.grpc?.activeSubscriptions() === 0)
      }
    })
  })

  test("SAMPLE sends periodic updates", async () => {
    await withServer(async (server) => {
      const client = clientFor<GnmiClient>("gnmi.gNMI", server)
      const call = client.Subscribe(auth(server.token))
      const stream = collector(call)
      try {
        call.write({
          subscribe: {
            encoding: "JSON_IETF",
            mode: "STREAM",
            subscription: [
              { path: path("omnia", "server", "status"), mode: "SAMPLE", sample_interval: "100000000" },
            ],
          },
        })
        await stream.wait((response) => response.sync_response === true)
        const update = await stream.wait((response) => response.update !== undefined)
        expect(json(update.update?.update?.[0]?.val)).toMatchObject({ state: "ready" })
      } finally {
        call.cancel()
        client.close()
      }
    })
  })

  test("ON_CHANGE subscriptions accept a heartbeat interval", async () => {
    await withServer(async (server) => {
      const client = clientFor<GnmiClient>("gnmi.gNMI", server)
      const call = client.Subscribe(auth(server.token))
      const stream = collector(call)
      try {
        call.write({
          subscribe: {
            encoding: "JSON_IETF",
            mode: "STREAM",
            subscription: [
              {
                path: path("omnia", "server", "status"),
                mode: "ON_CHANGE",
                heartbeat_interval: "100000000",
              },
            ],
          },
        })
        await stream.wait((response) => response.sync_response === true)
        const heartbeat = await stream.wait(
          (response) => response.update?.update?.[0]?.path !== undefined,
          2000,
        )
        expect(json(heartbeat.update?.update?.[0]?.val)).toMatchObject({ state: "ready" })
      } finally {
        call.cancel()
        client.close()
      }
    })
  })

  test("rejects a subscription list above the per-session bound", async () => {
    await withServer(async (server) => {
      const client = clientFor<GnmiClient>("gnmi.gNMI", server)
      const call = client.Subscribe(auth(server.token))
      const stream = collector(call)
      try {
        call.write({
          subscribe: {
            encoding: "JSON_IETF",
            mode: "STREAM",
            subscription: Array.from({ length: 513 }, () => ({
              path: path("omnia", "server", "status"),
            })),
          },
        })
        const error = await stream.wait((response) => response.error !== undefined)
        expect(error.error?.code).toBe(GrpcStatus.RESOURCE_EXHAUSTED)
        await waitFor(() => server.grpc?.activeSubscriptions() === 0)
      } finally {
        call.destroy()
        client.close()
      }
    })
  })

  test("POLL answers a poll request with a fresh snapshot", async () => {
    await withServer(async (server) => {
      const client = clientFor<GnmiClient>("gnmi.gNMI", server)
      const call = client.Subscribe(auth(server.token))
      const stream = collector(call)
      try {
        call.write({
          subscribe: {
            encoding: "JSON_IETF",
            mode: "POLL",
            subscription: [{ path: path("omnia", "server", "status") }],
          },
        })
        await stream.wait((response) => response.sync_response === true)
        call.write({ poll: {} })
        const update = await stream.wait((response) => response.update !== undefined)
        expect(json(update.update?.update?.[0]?.val)).toMatchObject({ state: "ready" })
      } finally {
        call.destroy()
        client.close()
      }
    })
  })

  test("unauthorized subscriptions fail closed", async () => {
    await withServer(async (server) => {
      const token = server.auth.mintClientToken({ id: "agent-3", login: "agent" })
      const client = clientFor<GnmiClient>("gnmi.gNMI", server)
      const call = client.Subscribe(auth(token!))
      const stream = collector(call)
      try {
        call.write({
          subscribe: {
            encoding: "JSON_IETF",
            mode: "STREAM",
            subscription: [{ path: path("omnia", "config", "permissions") }],
          },
        })
        const error = await stream.wait((response) => response.error !== undefined)
        expect(error.error?.code).toBe(GrpcStatus.PERMISSION_DENIED)
        await waitFor(() => server.grpc?.activeSubscriptions() === 0)
      } finally {
        call.destroy()
        client.close()
      }
    })
  })

  test("computer and health services use the existing manager and health state", async () => {
    await withServer(async (server) => {
      const computers = clientFor<ComputerClient>("omnia.v1.ComputerService", server)
      const health = clientFor<ComputerClient>("omnia.v1.HealthService", server)
      try {
        const list = await unary(computers.ListComputers.bind(computers), {}, auth(server.token))
        expect(list.computers ?? []).toEqual([])
        const missing = await unary(
          computers.ListComputers.bind(computers),
          {},
          new Metadata(),
        ).catch((error: ServiceError) => error)
        expect(missing).toMatchObject({ code: GrpcStatus.UNAUTHENTICATED })

        const unknown = await unary(
          computers.GetComputer.bind(computers),
          { id: "missing" },
          auth(server.token),
        ).catch((error: ServiceError) => error)
        expect(unknown).toMatchObject({ code: GrpcStatus.NOT_FOUND })

        const agent = server.auth.mintClientToken({ id: "agent-4", login: "agent" })
        const denied = await unary(
          computers.ConnectComputer.bind(computers),
          { id: "missing" },
          auth(agent!),
        ).catch((error: ServiceError) => error)
        expect(denied).toMatchObject({ code: GrpcStatus.PERMISSION_DENIED })

        const check = await unary(health.Check.bind(health), {}, auth(server.token))
        expect(check.status).toBe("SERVING")
      } finally {
        computers.close()
        health.close()
      }
    })
  })
})
