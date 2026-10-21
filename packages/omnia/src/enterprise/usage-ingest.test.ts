import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EnterpriseRuntime } from "./runtime"

// The desktop now sends finished turns here, so this endpoint is a contract
// between a shipped client and a server the client cannot update. The test
// covers the whole path the client uses: sign in for a client token, post a
// batch, and see the numbers land as usage the console reports on.

const directories: string[] = []
const servers: { close: () => void }[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function controlPlane() {
  const directory = mkdtempSync(join(tmpdir(), "omnia-usage-ingest-"))
  directories.push(directory)
  const runtime = new EnterpriseRuntime({
    file: join(directory, "enterprise.json"),
    publicUrl: "http://127.0.0.1:8787",
    orgName: "Acme Robotics",
    version: "1.0.3",
    build: false,
  })
  const token = runtime.store.bootstrap()!.token
  const owner = await runtime.store.setup({
    token,
    email: "owner@acme.test",
    name: "Owner",
    password: "correct horse battery",
  })
  const created = runtime.store.createDistribution({ name: "Acme Field" })
  runtime.store.updateDistribution(created.id, { telemetry: { ...created.telemetry, enabled: true } })
  const distribution = runtime.store.publishDistribution(created.id, "26.10.0", "")
  const server = createServer((request, response) => {
    void runtime.handle(request, response).catch(() => {
      response.statusCode = 500
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push({ close: () => server.close() })
  const port = (server.address() as AddressInfo).port
  const call = async (path: string, body: unknown, authorization?: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/enterprise/public/client/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: (text.length === 0 ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  return { runtime, distribution, owner, call }
}

describe("client usage ingest", () => {
  test("records a reported batch against the signed-in person and the build", async () => {
    const { runtime, distribution, owner, call } = await controlPlane()
    const login = await call(`${distribution.slug}/login`, { identifier: "owner@acme.test", password: "correct horse battery" })
    expect(login.status).toBe(200)
    const clientToken = String(login.body.token)

    const reported = await call(
      `${distribution.slug}/usage`,
      {
        events: [
          { model: "anthropic/claude-sonnet-4", provider: "anthropic", inputTokens: 1_200, outputTokens: 300, costUsd: 0.02, durationMs: 5_000, sessionId: "ses_1" },
          { model: "openai/gpt-5", inputTokens: 10, outputTokens: 5, costUsd: 0.001, tool: "bash" },
        ],
      },
      `Bearer ${clientToken}`,
    )
    expect(reported.status).toBe(200)
    expect(reported.body.accepted).toBe(2)

    const usage = runtime.store.usage()
    expect(usage).toHaveLength(2)
    expect(usage[0]).toMatchObject({
      userId: owner.user.id,
      distributionId: distribution.id,
      model: "anthropic/claude-sonnet-4",
      inputTokens: 1_200,
      outputTokens: 300,
      sessionId: "ses_1",
    })
    expect(usage[1]?.tool).toBe("bash")
  })

  test("refuses a batch without a client token", async () => {
    const { distribution, call } = await controlPlane()
    const reported = await call(`${distribution.slug}/usage`, { events: [{ model: "x", inputTokens: 1, outputTokens: 1, costUsd: 0 }] })
    expect(reported.status).toBe(401)
  })
})
