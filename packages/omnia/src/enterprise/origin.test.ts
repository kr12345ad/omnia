import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EnterpriseRuntime } from "./runtime"

// The console is served under a mount path, so its `publicUrl` names a path the
// browser's Origin header never carries. Comparing the two raw strings rejected
// every call from the console's own page — including invite links.

const directories: string[] = []
const servers: { close: () => void }[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function mountedConsole(options: { publicUrl: string; devOrigins?: string[] }) {
  const directory = mkdtempSync(join(tmpdir(), "omnia-origin-"))
  directories.push(directory)
  const runtime = new EnterpriseRuntime({
    file: join(directory, "enterprise.json"),
    publicUrl: options.publicUrl,
    ...(options.devOrigins === undefined ? {} : { devOrigins: options.devOrigins }),
    orgName: "Acme Robotics",
    version: "1.0.3",
    build: false,
  })
  const server = createServer((request, response) => {
    void runtime.handle(request, response).catch(() => {
      response.statusCode = 500
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push({ close: () => server.close() })
  const port = (server.address() as AddressInfo).port
  const get = async (origin?: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/enterprise/public/config`, {
      headers: origin === undefined ? {} : { origin },
    })
    return response.status
  }
  return { get }
}

describe("enterprise console origin check", () => {
  test("accepts the browser origin of a mounted console", async () => {
    const { get } = await mountedConsole({ publicUrl: "https://openfoodpantry.org/test1/ent" })
    expect(await get("https://openfoodpantry.org")).toBe(200)
  })

  test("still rejects other origins", async () => {
    const { get } = await mountedConsole({ publicUrl: "https://openfoodpantry.org/test1/ent" })
    expect(await get("https://elsewhere.test")).toBe(403)
  })

  test("accepts a dev origin written with a trailing slash", async () => {
    const { get } = await mountedConsole({
      publicUrl: "https://openfoodpantry.org/test1/ent",
      devOrigins: ["http://localhost:5173/"],
    })
    expect(await get("http://localhost:5173")).toBe(200)
  })

  test("accepts a root-mounted console and script clients", async () => {
    const { get } = await mountedConsole({ publicUrl: "https://console.acme.test" })
    expect(await get("https://console.acme.test")).toBe(200)
    expect(await get()).toBe(200)
  })
})
