import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EnterpriseRuntime } from "@opencode-ai/omnia/enterprise/runtime"
import "../../../test-support/electron"
import { writeTestAuthSession } from "../../../test-support/auth-session"
import { activateTestUserData } from "../../../test-support/user-data"
import { forgetEnterpriseProfile } from "./enterprise"

// A managed build's whole path, end to end: the profile an installer bakes, the
// session its sign-in leaves behind, the renderer's per-turn event, the durable
// outbox, the HTTP contract, and the server that records the cost. Only Electron
// is stubbed, because this is the main process with no app around it.

const directory = mkdtempSync(join(tmpdir(), "omnia-usage-report-"))
const userData = join(directory, "userData")
mkdirSync(userData, { recursive: true })

// The shared substitution stands in for Electron; this suite points its fake
// app at the userData directory it built above.
activateTestUserData(userData)

const servers: Server[] = []

const serverUrl = await (async () => {
  const server: Server = createServer((request, response) => {
    void runtime.handle(request, response).catch(() => {
      response.statusCode = 500
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})()

const runtime = new EnterpriseRuntime({
  file: join(directory, "enterprise.json"),
  publicUrl: serverUrl,
  orgName: "Acme Robotics",
  version: "1.0.3",
  build: false,
})

const setup = await (async () => {
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
  const login = await fetch(`${serverUrl}/v1/enterprise/public/client/${distribution.slug}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: "owner@acme.test", password: "correct horse battery" }),
  })
  const body = (await login.json()) as { token?: string }
  return { owner: owner.user, distribution, clientToken: body.token }
})()

const profilePath = join(directory, "enterprise.json")
writeFileSync(
  profilePath,
  JSON.stringify({
    kind: "omnia-enterprise-client",
    schema: 1,
    distribution: setup.distribution.slug,
    version: "26.10.0",
    name: "Acme Field",
    appId: "test.acme.field",
    server: serverUrl,
    manifestUrl: `${serverUrl}/v1/enterprise/public/client/${setup.distribution.slug}/manifest`,
    loginUrl: `${serverUrl}/v1/enterprise/public/client/${setup.distribution.slug}/login`,
    org: { name: "Acme Robotics", slug: "acme-robotics" },
    telemetry: { enabled: true },
  }),
)
// The session this suite's own sign-in produced is a real file in the userData
// directory above, so the shipped reader finds it and no module is replaced for
// later suites.
writeTestAuthSession(userData, { url: serverUrl, clientToken: setup.clientToken })

const { reportEnterpriseUsage, flushEnterpriseUsage } = await import("./usage-report")

beforeAll(() => {
  // Bun runs every file in one process, so a suite that signs in against its
  // own control plane can leave the profile unset by the time this file runs.
  // Both the environment and the resolved profile are set here, immediately
  // before the first turn is reported.
  process.env.OMNIA_ENTERPRISE_PROFILE = profilePath
  forgetEnterpriseProfile()
})

afterAll(() => {
  delete process.env.OMNIA_ENTERPRISE_PROFILE
  for (const server of servers.splice(0)) server.close()
  mock.restore()
  rmSync(directory, { recursive: true, force: true })
})

describe("managed build usage reporting", () => {
  test("a finished turn reaches the control plane with its cost", async () => {
    const queued = reportEnterpriseUsage({
      key: "msg_01H",
      model: "opencode/big-pickle",
      provider: "opencode",
      inputTokens: 1_200,
      outputTokens: 300,
      costUsd: 0.0425,
      durationMs: 5_000,
      sessionId: "ses_1",
    })
    expect(queued.queued).toBe(true)

    await flushEnterpriseUsage()

    const usage = runtime.store.usage()
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({
      userId: setup.owner.id,
      model: "opencode/big-pickle",
      provider: "opencode",
      inputTokens: 1_200,
      outputTokens: 300,
      costUsd: 0.0425,
      durationMs: 5_000,
      sessionId: "ses_1",
      distributionId: setup.distribution.id,
    })
  })

  test("replaying the same turn reports nothing twice", async () => {
    const again = reportEnterpriseUsage({
      key: "msg_01H",
      model: "opencode/big-pickle",
      inputTokens: 1_200,
      outputTokens: 300,
      costUsd: 0.0425,
    })
    expect(again.queued).toBe(false)
    await flushEnterpriseUsage()
    expect(runtime.store.usage()).toHaveLength(1)
  })

  test("the console reports the cost it recorded", () => {
    const totals = runtime.store.usage().reduce(
      (sum, event) => ({ cost: sum.cost + event.costUsd, input: sum.input + event.inputTokens }),
      { cost: 0, input: 0 },
    )
    expect(totals.cost).toBeCloseTo(0.0425, 6)
    expect(totals.input).toBe(1_200)
  })
})
