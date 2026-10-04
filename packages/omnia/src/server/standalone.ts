#!/usr/bin/env bun
// Standalone Omnia server: hosts the computer-control API as a long-lived
// service so thin clients can connect remotely. The desktop app embeds the
// same server; this entrypoint is for hosted deployments.
import { createHostDriver } from "../daemon/host-driver"
import { LinuxHostDriver } from "../daemon/linux"
import { startOmniaServer } from "./server"
import type { ServerComputerDriver } from "./computers"
import type { HostDriver } from "../daemon/host-driver"
import type { CommandRequest } from "../protocol"

function toServerDriver(driver: HostDriver): ServerComputerDriver {
  return {
    id: driver.id,
    backend: driver.backend,
    ...(driver.engine === undefined ? {} : { cua: driver.engine }),
    getInfo: () => driver.getInfo(),
    capabilities: () => driver.capabilities ?? [],
    observe: (request) => driver.observe(request),
    find: (request) => driver.find(request),
    execute: (action) => driver.execute(action),
    ...(driver.runCommand === undefined ? {} : { runCommand: (request: CommandRequest) => driver.runCommand!(request) }),
    ...(driver.readText === undefined ? {} : { readText: (input: Parameters<NonNullable<HostDriver["readText"]>>[0]) => driver.readText!(input) }),
    ...(driver.readClipboard === undefined ? {} : { readClipboard: () => driver.readClipboard!() }),
    ...(driver.writeClipboard === undefined ? {} : { writeClipboard: (text: string) => driver.writeClipboard!(text) }),
    ...(driver.writeClipboardImage === undefined
      ? {}
      : { writeClipboardImage: (path: string) => driver.writeClipboardImage!(path) }),
    ...(driver.pointerPosition === undefined ? {} : { pointerPosition: () => driver.pointerPosition!() }),
    ...(driver.hoverPointer === undefined ? {} : { hoverPointer: (x: number, y: number, holdMs?: number) => driver.hoverPointer!(x, y, holdMs) }),
    ...(driver.mouseDown === undefined ? {} : { mouseDown: (button?: number) => driver.mouseDown!(button) }),
    ...(driver.mouseUp === undefined ? {} : { mouseUp: (button?: number) => driver.mouseUp!(button) }),
    ...(driver.releaseStuckKeys === undefined ? {} : { releaseStuckKeys: () => driver.releaseStuckKeys!() }),
    ...(driver.grabInput === undefined ? {} : { grabInput: (reason?: string) => driver.grabInput!(reason) }),
    ...(driver.releaseInput === undefined ? {} : { releaseInput: () => driver.releaseInput!() }),
    ...(driver.inputGrabState === undefined ? {} : { inputGrabState: () => driver.inputGrabState!() }),
    ...(driver.subscribeInputGrab === undefined
      ? {}
      : { subscribeInputGrab: (listener: Parameters<NonNullable<HostDriver["subscribeInputGrab"]>>[0]) => driver.subscribeInputGrab!(listener) }),
    revalidateTarget: (reference) => driver.revalidateTarget(reference),
  }
}

function hostDriver(): HostDriver | undefined {
  if (process.platform !== "linux") return createHostDriver()
  const host = new LinuxHostDriver()
  if (!host.available) return undefined
  return createHostDriver(host)
}

// A hosted control plane normally controls paired runtimes, not the machine it
// runs on. Register the local host only when explicitly requested.
const localDriver = process.env.OMNIA_LOCAL_DRIVER === "1" ? hostDriver() : undefined
if (process.env.OMNIA_LOCAL_DRIVER === "1" && localDriver === undefined) {
  console.error("OMNIA_LOCAL_DRIVER=1 was set, but this host has no available input backend.")
  process.exit(1)
}

const host = process.env.OMNIA_SERVER_HOST ?? "127.0.0.1"
const port = process.env.OMNIA_SERVER_PORT === undefined ? undefined : Number(process.env.OMNIA_SERVER_PORT)
if (port !== undefined && (!Number.isFinite(port) || port < 0 || port > 65535)) {
  console.error("OMNIA_SERVER_PORT must be a valid port number.")
  process.exit(1)
}

const handle = await startOmniaServer({
  drivers: localDriver === undefined ? [] : [toServerDriver(localDriver)],
  host,
  ...(port === undefined ? {} : { port }),
  ...(process.env.OMNIA_SERVER_TOKEN === undefined ? {} : { token: process.env.OMNIA_SERVER_TOKEN }),
  ...(process.env.OMNIA_PUBLIC_URL === undefined ? {} : { publicUrl: process.env.OMNIA_PUBLIC_URL }),
  // Hosted control planes gate pairing centrally; LAN discovery is opt-in.
  discovery: process.env.OMNIA_DISCOVERY === "1",
  ...(process.env.OMNIA_AUTH_FILE === undefined ? {} : { authFile: process.env.OMNIA_AUTH_FILE }),
  ...(process.env.OMNIA_PAIRINGS_FILE === undefined ? {} : { pairingsFile: process.env.OMNIA_PAIRINGS_FILE }),
  ...(process.env.OMNIA_MODELS_DIR === undefined ? {} : { modelsDir: process.env.OMNIA_MODELS_DIR }),
})

console.log(
  JSON.stringify({
    url: handle.url,
    token: handle.token,
    serverId: handle.serverId,
    ...(localDriver === undefined ? {} : { computerId: localDriver.id }),
    platform: process.platform,
    pid: process.pid,
  }),
)

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}; stopping the Omnia server.`)
  await handle.stop().catch(() => undefined)
  process.exit(0)
}
process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))

await new Promise(() => {})
