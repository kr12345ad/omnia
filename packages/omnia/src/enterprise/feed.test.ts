import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EnterpriseRuntime } from "./runtime"

// The update feed is what lets a fleet move: the version an admin published, the
// channel rules they set, and the artifact for the platform asking. These tests
// pin the contract because an updater is the one client that cannot be asked to
// try again tomorrow.

const directories: string[] = []
const servers: { close: () => void }[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function controlPlane() {
  const directory = mkdtempSync(join(tmpdir(), "omnia-enterprise-feed-"))
  directories.push(directory)
  const runtime = new EnterpriseRuntime({
    file: join(directory, "enterprise.json"),
    publicUrl: "http://127.0.0.1:8787",
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
  const get = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`)
    const text = await response.text()
    return { status: response.status, body: (text.length === 0 ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  return { runtime, get }
}

describe("client update feed", () => {
  test("publishes the version, channel rules and per-platform artifacts", async () => {
    const { runtime, get } = await controlPlane()
    const created = runtime.store.createDistribution({ name: "Acme Field" })
    runtime.store.updateDistribution(created.id, {
      deployment: { ...created.deployment, platforms: ["linux-x64", "windows-x64"] },
      update: { channel: "pinned", pinnedVersion: "26.10.0", autoUpdate: false, allowDowngrade: false, minimumVersion: "26.9.0" },
    })
    runtime.store.publishDistribution(created.id, "26.10.0", "Winter release")

    const feed = await get("/v1/enterprise/public/client/acme-field/update")
    expect(feed.status).toBe(200)
    const update = feed.body.update as Record<string, unknown>
    expect(update.version).toBe("26.10.0")
    expect(update.channel).toBe("pinned")
    expect(update.pinnedVersion).toBe("26.10.0")
    expect(update.minimumVersion).toBe("26.9.0")
    expect(update.autoUpdate).toBe(false)
    expect(update.allowDowngrade).toBe(false)
    const installers = update.installers as { platform: string; url: string; kind: string }[]
    expect(installers.map((installer) => installer.platform)).toEqual(["linux-x64", "windows-x64"])
    expect(installers[0]?.url).toBe(
      "http://127.0.0.1:8787/v1/enterprise/public/client/acme-field/download/linux-x64",
    )
  })

  test("is not served for an unpublished build", async () => {
    const { runtime, get } = await controlPlane()
    runtime.store.createDistribution({ name: "Acme Draft" })
    const feed = await get("/v1/enterprise/public/client/acme-draft/update")
    expect(feed.status).toBe(404)
  })
})
