import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  credentials,
  Metadata,
  makeGenericClientConstructor,
  status as GrpcStatus,
  type ClientDuplexStream,
  type ServiceDefinition,
} from "@grpc/grpc-js"
import { loadFileDescriptorSetFromBuffer, type PackageDefinition } from "@grpc/proto-loader"
import { SecurityJournal } from "../../security/journal"
import { RemoteRegistry } from "../remote"
import { startOmniaServer, type OmniaServerHandle, type OmniaServerOptions } from "../server"
import { GNMI_DESCRIPTOR_BASE64 } from "./generated/descriptor"
import { startGrpcServer, type GrpcServerOptions } from "./server"
import type { ProtoSubscribeRequest, ProtoSubscribeResponse } from "./types"

interface GnmiClient {
  Subscribe(metadata: Metadata): ClientDuplexStream<ProtoSubscribeRequest, ProtoSubscribeResponse>
  close(): void
}

const PACKAGE: PackageDefinition = loadFileDescriptorSetFromBuffer(
  Buffer.from(GNMI_DESCRIPTOR_BASE64, "base64"),
  { keepCase: true, longs: String, enums: String, oneofs: true, defaults: false },
)

function clientFor(server: OmniaServerHandle): GnmiClient {
  const service = "gnmi.gNMI"
  const constructor = makeGenericClientConstructor(PACKAGE[service] as ServiceDefinition, service)
  const address = server.grpc?.url.replace(/^grpcs?:\/\//, "")
  if (address === undefined) throw new Error("The test server did not start gRPC.")
  return new constructor(address, credentials.createInsecure()) as unknown as GnmiClient
}

function auth(token: string): Metadata {
  const metadata = new Metadata()
  metadata.set("authorization", `Bearer ${token}`)
  return metadata
}

function options(dir: string, extra: Partial<OmniaServerOptions> = {}): OmniaServerOptions {
  return {
    authFile: join(dir, "auth.json"),
    auditFile: join(dir, "audit.jsonl"),
    ...extra,
  }
}

async function probeHttpPort(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "omnia-grpc-lifecycle-"))
  const probe = await startOmniaServer(options(dir, { grpc: { enabled: false } }))
  try {
    return Number(new URL(probe.url).port)
  } finally {
    await probe.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const listener = createServer()
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject)
    listener.listen(0, "127.0.0.1", () => {
      listener.off("error", reject)
      resolve()
    })
  })
  const address = listener.address()
  if (address === null || typeof address === "string") throw new Error("The occupied test port is unavailable.")
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => listener.close(() => resolve())),
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for gRPC lifecycle state.")
    await Bun.sleep(10)
  }
}

async function withBaseServer<T>(fn: (server: OmniaServerHandle, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "omnia-grpc-lifecycle-"))
  const server = await startOmniaServer(options(dir, { grpc: { enabled: false } }))
  try {
    return await fn(server, dir)
  } finally {
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

function grpcOptions(server: OmniaServerHandle, dir: string, overrides: Partial<GrpcServerOptions>): GrpcServerOptions {
  const remote = new RemoteRegistry({
    events: server.events,
    registerDriver: () => () => undefined,
    now: Date.now,
  })
  const audit = new SecurityJournal(join(dir, "grpc-audit.jsonl"))
  return {
    token: server.token,
    auth: server.auth,
    remote,
    source: {
      url: server.url,
      health: server.health,
      computers: () => server.computers.list(),
      sessions: () => [],
      chatChannels: () => server.chatChannels.describe(),
      permissions: () => server.permissions.snapshot(),
    },
    computers: server.computers,
    permissions: server.permissions,
    events: server.events,
    serverId: server.serverId,
    now: Date.now,
    audit,
    ...overrides,
  }
}

describe("Omnia gRPC lifecycle and binding policy", () => {
  test("grpc.enabled=false leaves the HTTP API healthy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-grpc-lifecycle-"))
    const server = await startOmniaServer(options(dir, { grpc: { enabled: false } }))
    try {
      expect(server.grpc).toBeUndefined()
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

  test("an occupied gRPC port rejects startup and releases the HTTP listener", async () => {
    const occupied = await occupyPort()
    const httpPort = await probeHttpPort()
    const dir = mkdtempSync(join(tmpdir(), "omnia-grpc-lifecycle-"))
    try {
      await expect(
        startOmniaServer(
          options(dir, {
            port: httpPort,
            grpc: { enabled: true, port: occupied.port },
          }),
        ),
      ).rejects.toThrow()

      // A failed startup must not leave the HTTP listener holding the port.
      const replacement = await startOmniaServer(
        options(dir, {
          authFile: join(dir, "replacement-auth.json"),
          auditFile: join(dir, "replacement-audit.jsonl"),
          port: httpPort,
          grpc: { enabled: false },
        }),
      )
      try {
        expect(Number(new URL(replacement.url).port)).toBe(httpPort)
      } finally {
        await replacement.stop()
      }
    } finally {
      await occupied.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("startGrpcServer refuses a non-loopback host without allowRemote", async () => {
    await withBaseServer(async (server, dir) => {
      const grpc = grpcOptions(server, dir, { host: "0.0.0.0" })
      try {
        await expect(startGrpcServer(grpc)).rejects.toThrow(/loopback/)
      } finally {
        grpc.remote.close()
        grpc.audit.close()
      }
    })
  })

  test("startGrpcServer refuses cleartext remote binding without TLS", async () => {
    await withBaseServer(async (server, dir) => {
      const grpc = grpcOptions(server, dir, { host: "0.0.0.0", allowRemote: true })
      try {
        await expect(startGrpcServer(grpc)).rejects.toThrow(/TLS/)
      } finally {
        grpc.remote.close()
        grpc.audit.close()
      }
    })
  })

  test("server.stop releases the gRPC port for a new server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-grpc-lifecycle-"))
    const first = await startOmniaServer(options(dir, { grpc: { enabled: true } }))
    const port = first.grpc?.port
    expect(port).toBeGreaterThan(0)
    await first.stop()

    const second = await startOmniaServer(
      options(dir, {
        authFile: join(dir, "second-auth.json"),
        auditFile: join(dir, "second-audit.jsonl"),
        grpc: { enabled: true, port },
      }),
    )
    try {
      expect(second.grpc?.port).toBe(port)
    } finally {
      await second.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a revoked client token stops an active subscription", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-grpc-lifecycle-"))
    const server = await startOmniaServer(options(dir, { grpc: { enabled: true } }))
    const token = server.auth.mintClientToken({ id: "agent-1", login: "agent" })
    if (token === undefined) throw new Error("The test token was not minted.")
    const client = clientFor(server)
    const call = client.Subscribe(auth(token))
    let resolveSync: () => void = () => undefined
    const synced = new Promise<void>((resolve) => {
      resolveSync = resolve
    })
    // Subscription errors are protocol notifications followed by a clean end.
    const revoked = new Promise<number>((resolve) => {
      call.on("data", (response: ProtoSubscribeResponse) => {
        if (response.sync_response === true) resolveSync()
        if (response.error?.code !== undefined) resolve(response.error.code)
      })
    })
    try {
      call.write({
        subscribe: {
          encoding: "JSON_IETF",
          mode: "STREAM",
          subscription: [
            {
              path: {
                origin: "omnia",
                elem: [{ name: "omnia" }, { name: "server" }, { name: "status" }],
              },
            },
          ],
        },
      })
      await synced
      expect(server.grpc?.activeSubscriptions()).toBe(1)

      await server.auth.logout()

      expect(await revoked).toBe(GrpcStatus.UNAUTHENTICATED)
      await waitFor(() => server.grpc?.activeSubscriptions() === 0)
    } finally {
      call.destroy()
      client.close()
      await server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("active subscriptions are released by server.stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-grpc-lifecycle-"))
    const server = await startOmniaServer(options(dir, { grpc: { enabled: true } }))
    const client = clientFor(server)
    const call = client.Subscribe(auth(server.token))
    // server.stop() closes the stream; the client reports that as UNAVAILABLE.
    // The assertion is about server-side cleanup, not about hiding the signal.
    call.on("error", () => undefined)
    let stopped = false
    try {
      call.write({
        subscribe: {
          encoding: "JSON_IETF",
          mode: "STREAM",
          subscription: [
            {
              path: {
                origin: "omnia",
                elem: [{ name: "omnia" }, { name: "server" }, { name: "status" }],
              },
            },
          ],
        },
      })
      await waitFor(() => server.grpc?.activeSubscriptions() === 1)
      await server.stop()
      stopped = true
      expect(server.grpc?.activeSubscriptions()).toBe(0)
    } finally {
      call.destroy()
      client.close()
      if (!stopped) await server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
