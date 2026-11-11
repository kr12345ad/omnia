import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startOmniaServer } from "./server"
import { sessionProof } from "./api"
import type { CommandRequest, ServerComputerDriver } from "./computers"
import type { ActionResult, ComputerAction, Observation } from "../protocol"

interface CommandDriverHarness {
  driver: ServerComputerDriver
  commands: CommandRequest[]
  releaseCalls: () => number
  clickCount: () => number
  holdClicks: () => void
  releaseClicks: () => void
  lastAction: () => ComputerAction | undefined
  exitCodes: Array<{ exitCode: number; timedOut?: boolean }>
}

function createCommandDriver(): CommandDriverHarness {
  const commands: CommandRequest[] = []
  const exitCodes: Array<{ exitCode: number; timedOut?: boolean }> = []
  const pending: Array<() => void> = []
  let releaseCalls = 0
  let clickCount = 0
  let holding = false
  let lastAction: ComputerAction | undefined
  const driver: ServerComputerDriver = {
    id: "local",
    backend: "test",
    getInfo: async () => ({ id: "local", name: "Test Computer", platform: "linux", connected: true }),
    capabilities: () => [],
    observe: async (): Promise<Observation> => ({
      id: "obs-1",
      elements: [
        {
          id: "el-1",
          role: "textbox",
          name: "Command",
          value: "ls -la",
          states: ["focused"],
          actions: ["click"],
          bounds: { x: 10, y: 10, width: 100, height: 20 },
        },
      ],
    }),
    find: async (request) => ({ query: request.query, matches: [{ element: { id: "el-1", role: "textbox", name: "Command" }, score: 1 }] }),
    execute: async (action): Promise<ActionResult> => {
      lastAction = action
      if (action.type === "click") {
        clickCount += 1
        if (holding) await new Promise<void>((resolve) => pending.push(resolve))
      }
      return { success: true, status: "success", message: `Executed ${action.type}.` }
    },
    runCommand: async (request) => {
      commands.push(request)
      const password = request.stdin?.trim()
      const planned = exitCodes.shift() ?? { exitCode: 0 }
      return {
        success: true,
        status: "success",
        message: planned.exitCode === 0 ? "Command exited with code 0." : `Command exited with code ${planned.exitCode}.`,
        command: {
          exitCode: planned.exitCode,
          stdout: `ok ${password ?? ""}`.trim(),
          stderr: "",
          truncated: false,
          timedOut: planned.timedOut === true,
          durationMs: 4,
        },
      }
    },
    releaseInput: async () => {
      releaseCalls += 1
      return { success: true, status: "success", message: "Input released." }
    },
    releaseStuckKeys: async () => ({ success: true, status: "success", message: "Keys released." }),
  }
  return {
    driver,
    commands,
    releaseCalls: () => releaseCalls,
    clickCount: () => clickCount,
    holdClicks: () => {
      holding = true
    },
    releaseClicks: () => {
      holding = false
      for (const resolve of pending.splice(0)) resolve()
    },
    lastAction: () => lastAction,
    exitCodes,
  }
}

async function withCommandServer<T>(
  harness: CommandDriverHarness,
  fn: (server: Awaited<ReturnType<typeof startOmniaServer>>, call: Caller) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "omnia-command-"))
  const server = await startOmniaServer({
    drivers: [harness.driver],
    credentialsFile: join(dir, "credentials.json"),
    authFile: join(dir, "auth.json"),
    superskillFile: join(dir, "superskills.json"),
    memoryFile: join(dir, "memories.json"),
    computerUseFile: join(dir, "computer-use.json"),
  })
  const call: Caller = async (path, body) => {
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined
    const response = await fetch(`${server.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
        ...(sessionId === undefined ? {} : { "x-omnia-session-proof": sessionProof(server.token, sessionId) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  try {
    return await fn(server, call)
  } finally {
    await server.stop()
  }
}

type Caller = (path: string, body?: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>

const approval = {
  approve: true,
  approvedBy: "session:test",
  sessionId: "session-1",
}

describe("run_command", () => {
  test("approval distinguishes shell command case", async () => {
    const harness = createCommandDriver()
    await withCommandServer(harness, async (_server, call) => {
      const issued = await call("/v1/permissions/approve", {
        action: "run_command", computerId: "local", resources: ["echo SAFE"], command: "echo SAFE", maxUses: 1,
      })
      const fingerprint = (issued.body.approval as { fingerprint: string }).fingerprint
      const response = await call("/v1/computers/local/actions", {
        action: "run_command", command: "echo safe", approvalFingerprint: fingerprint, sessionId: "session-1",
      })
      expect(response.status).toBe(428)
      expect(harness.commands).toHaveLength(0)
      for (const changed of [{ cwd: "/different" }, { credential: "none" }]) {
        const denied = await call("/v1/computers/local/actions", {
          action: "run_command", command: "echo SAFE", approvalFingerprint: fingerprint,
          sessionId: "session-1", ...changed,
        })
        expect(denied.status).toBe(428)
      }
      const original = await call("/v1/computers/local/actions", {
        action: "run_command", text: "echo SAFE", approvalFingerprint: fingerprint, sessionId: "session-1",
      })
      expect(original.status).toBe(200)
    })
  })

  test("shell approvals require and bind the target computer", async () => {
    const harness = createCommandDriver()
    await withCommandServer(harness, async (_server, call) => {
      const operation = { action: "run_command", resources: ["echo hello"], command: "echo hello" }
      expect((await call("/v1/permissions/approve", operation)).status).toBe(400)
      const issued = await call("/v1/permissions/approve", { ...operation, computerId: "another-computer" })
      expect(issued.status).toBe(200)
      const denied = await call("/v1/computers/local/actions", {
        action: "run_command", command: "echo hello", sessionId: "session-1",
        approvalFingerprint: (issued.body.approval as { fingerprint: string }).fingerprint,
      })
      expect(denied.status).toBe(428)
      expect(harness.commands).toHaveLength(0)
    })
  })

  test("redacts command errors and nested metadata", async () => {
    const harness = createCommandDriver()
    harness.driver.runCommand = async () => ({
      success: false, status: "failed", message: "failed with synthetic-secret",
      error: { code: "command_failed", message: "synthetic-secret", retryable: false },
      metadata: { diagnostic: { value: "synthetic-secret" } },
    })
    await withCommandServer(harness, async (_server, call) => {
      await call("/v1/computers/local/credentials", {
        computerId: "local", name: "sudo", kind: "password", secret: "synthetic-secret",
        rules: [{ kind: "command", match: "sudo" }],
      })
      await call("/v1/permissions", { scope: "SECRETS", state: "prompt" })
      const response = await call("/v1/computers/local/actions", {
        action: "run_command", command: "sudo whoami", ...approval,
        approvedScopes: ["PROCESS_EXECUTE", "SECRETS"],
      })
      expect(response.status).toBe(500)
      expect(JSON.stringify(response.body)).not.toContain("synthetic-secret")
      expect(JSON.stringify(response.body)).toContain("[redacted]")
    })
  })

  test("runs a shell command and verifies the exit code", async () => {
    const harness = createCommandDriver()
    await withCommandServer(harness, async (_server, call) => {
      const response = await call("/v1/computers/local/actions", {
        action: "run_command",
        command: "echo hello",
        approvedScopes: ["PROCESS_EXECUTE"],
        ...approval,
      })
      expect(response.status).toBe(200)
      expect(response.body.ok).toBe(true)
      const result = response.body.result as { success: boolean; verification?: { status: string; method?: string }; command?: { exitCode: number } }
      expect(result.success).toBe(true)
      expect(result.verification?.status).toBe("verified")
      expect(result.verification?.method).toBe("exit-code")
      expect(result.command?.exitCode).toBe(0)
      expect(harness.commands[0]?.command).toBe("echo hello")
    })
  })

  test("requires SECRETS approval when a stored credential matches", async () => {
    const harness = createCommandDriver()
    await withCommandServer(harness, async (_server, call) => {
      const created = await call("/v1/computers/local/credentials", {
        computerId: "local",
        name: "sudo",
        kind: "password",
        secret: "hunter2",
        rules: [{ kind: "command", match: "sudo" }],
      })
      expect(created.status).toBe(200)

      const denied = await call("/v1/computers/local/actions", {
        action: "run_command",
        command: "sudo whoami",
        approvedScopes: ["PROCESS_EXECUTE"],
        ...approval,
      })
      expect(denied.status).toBe(403)
      const error = (denied.body.result as { error?: { code?: string; details?: { missing?: string[]; credential?: { name?: string } } } }).error
      expect(error?.code).toBe("permission_denied")
      expect(error?.details?.missing).toContain("SECRETS")
      expect(error?.details?.credential?.name).toBe("sudo")

      // Only the operator can lift a denied scope, so it permits SECRETS
      // itself before the agent relays an approval that names it.
      const permitted = await call("/v1/permissions", { scope: "SECRETS", state: "prompt" })
      expect(permitted.status).toBe(200)
      const allowed = await call("/v1/computers/local/actions", {
        action: "run_command",
        command: "sudo whoami",
        approvedScopes: ["PROCESS_EXECUTE", "SECRETS"],
        ...approval,
      })
      expect(allowed.status).toBe(200)
      const result = allowed.body.result as { success: boolean; command?: { stdout: string } }
      expect(result.success).toBe(true)
      expect(harness.commands[0]?.command).toContain("sudo -S -p ''")
      expect(harness.commands[0]?.stdin).toBe("hunter2\n")
      expect(result.command?.stdout).toBe("ok [redacted]")
    })
  })

  test("a non-zero exit answers a failure status with an error object", async () => {
    const harness = createCommandDriver()
    harness.exitCodes.push({ exitCode: 3 })
    await withCommandServer(harness, async (_server, call) => {
      const response = await call("/v1/computers/local/actions", {
        action: "run_command",
        command: "false",
        approvedScopes: ["PROCESS_EXECUTE"],
        ...approval,
      })
      expect(response.status).toBe(409)
      expect(response.body.ok).toBe(false)
      const result = response.body.result as {
        success: boolean
        error?: { code?: string; details?: { exitCode?: number } }
        verification?: { status: string }
      }
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe("command_failed")
      expect(result.error?.details?.exitCode).toBe(3)
      expect(result.verification?.status).toBe("failed")
    })
  })

  test("a timed-out command answers 504", async () => {
    const harness = createCommandDriver()
    harness.exitCodes.push({ exitCode: 124, timedOut: true })
    await withCommandServer(harness, async (_server, call) => {
      const response = await call("/v1/computers/local/actions", {
        action: "run_command",
        command: "sleep 100",
        approvedScopes: ["PROCESS_EXECUTE"],
        ...approval,
      })
      expect(response.status).toBe(504)
      expect((response.body.result as { error?: { code?: string } }).error?.code).toBe("command_timeout")
    })
  })

  test("passes credential environment variables for non-sudo commands", async () => {
    const harness = createCommandDriver()
    await withCommandServer(harness, async (_server, call) => {
      await call("/v1/computers/local/credentials", {
        computerId: "local",
        name: "login",
        kind: "username_password",
        username: "krishnaa",
        secret: "pw",
        rules: [{ kind: "command", match: "gh auth login" }],
      })
      const permitted = await call("/v1/permissions", { scope: "SECRETS", state: "prompt" })
      expect(permitted.status).toBe(200)
      const response = await call("/v1/computers/local/actions", {
        action: "run_command",
        command: "gh auth login",
        credential: "auto",
        approvedScopes: ["PROCESS_EXECUTE", "SECRETS"],
        ...approval,
      })
      expect(response.status).toBe(200)
      expect(harness.commands[0]?.env?.OMNIA_CREDENTIAL_USERNAME).toBe("krishnaa")
      expect(harness.commands[0]?.env?.OMNIA_CREDENTIAL_PASSWORD).toBe("pw")
      expect(harness.commands[0]?.stdin).toBeUndefined()
    })
  })
})

describe("credential API", () => {
  test("creates, lists masked, and removes credentials", async () => {
    const harness = createCommandDriver()
    await withCommandServer(harness, async (_server, call) => {
      const created = await call("/v1/computers/local/credentials", {
        computerId: "local",
        name: "portal",
        kind: "password",
        secret: "top-secret",
        rules: [{ kind: "url", match: "https://portal.example" }],
      })
      expect(created.status).toBe(200)
      const id = (created.body.credential as { id: string }).id

      const listed = await call("/v1/computers/local/credentials")
      expect(listed.status).toBe(200)
      const credentials = listed.body.credentials as Array<Record<string, unknown>>
      expect(credentials).toHaveLength(1)
      expect(credentials[0]?.hasSecret).toBe(true)
      expect(JSON.stringify(credentials)).not.toContain("top-secret")

      const removed = await fetch(`${_server.url}/v1/computers/local/credentials/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${_server.token}` },
      })
      expect(removed.status).toBe(200)
      const after = await call("/v1/computers/local/credentials")
      expect((after.body.credentials as unknown[]).length).toBe(0)
    })
  })

  test("the model-facing credentials action needs SECRETS approval", async () => {
    const harness = createCommandDriver()
    await withCommandServer(harness, async (_server, call) => {
      await call("/v1/computers/local/credentials", {
        computerId: "local",
        name: "sudo",
        kind: "password",
        secret: "pw",
        rules: [{ kind: "command", match: "sudo" }],
      })
      const denied = await call("/v1/computers/local/actions", {
        action: "credentials",
        approve: true,
        approvedBy: "session:test",
        approvedScopes: ["UI_READ"],
        sessionId: "session-1",
      })
      expect(denied.status).toBe(403)
      expect((denied.body.result as { error?: { code?: string } }).error?.code).toBe("permission_denied")
      const permitted = await call("/v1/permissions", { scope: "SECRETS", state: "prompt" })
      expect(permitted.status).toBe(200)
      const allowed = await call("/v1/computers/local/actions", {
        action: "credentials",
        approvedScopes: ["SECRETS"],
        ...approval,
      })
      expect(allowed.status).toBe(200)
      const metadata = (allowed.body.result as { metadata?: { credentials?: Array<{ name: string; rules: unknown[] }> } }).metadata
      expect(metadata?.credentials?.[0]?.name).toBe("sudo")
      expect(metadata?.credentials?.[0]?.rules).toHaveLength(1)
    })
  })

  test("bare approve:true with empty scopes cannot bypass denied SECRETS", async () => {
    const harness = createCommandDriver()
    await withCommandServer(harness, async (_server, call) => {
      await call("/v1/computers/local/credentials", {
        computerId: "local",
        name: "sudo",
        kind: "password",
        secret: "pw",
        rules: [{ kind: "command", match: "sudo" }],
      })
      const denied = await call("/v1/computers/local/actions", {
        action: "credentials",
        approve: true,
        approvedBy: "session:test",
        approvedScopes: [],
        sessionId: "session-1",
      })
      expect(denied.status).toBe(403)
      const error = (denied.body.result as { error?: { code?: string; details?: { missing?: string[] } } }).error
      expect(error?.code).toBe("permission_denied")
      expect(error?.details?.missing).toContain("SECRETS")
    })
  })

  test("binds an operator approval to the exact operation fingerprint", async () => {
    const harness = createCommandDriver()
    await withCommandServer(harness, async (_server, call) => {
      const issued = await call("/v1/permissions/approve", {
        action: "run_command",
        computerId: "local",
        resources: ["echo hello"],
        command: "echo hello",
        expiresInMs: 60000,
        maxUses: 1,
      })
      expect(issued.status).toBe(200)
      const fingerprint = (issued.body.approval as { fingerprint: string }).fingerprint

      const mismatched = await call("/v1/computers/local/actions", {
        action: "run_command",
        command: "echo hello",
        approvalFingerprint: "deadbeef",
        sessionId: "session-1",
      })
      expect(mismatched.status).toBe(428)

      const approved = await call("/v1/computers/local/actions", {
        action: "run_command",
        command: "echo hello",
        approvalFingerprint: fingerprint,
        sessionId: "session-1",
      })
      expect(approved.status).toBe(200)
      expect((approved.body.result as { success: boolean }).success).toBe(true)

      const replayed = await call("/v1/computers/local/actions", {
        action: "run_command",
        command: "echo hello",
        approvalFingerprint: fingerprint,
        sessionId: "session-1",
      })
      expect(replayed.status).toBe(428)
    })
  })
})

describe("emergency stop", () => {
  test("stop releases input and blocks later actions until connect", async () => {
    const harness = createCommandDriver()
    await withCommandServer(harness, async (_server, call) => {
      const before = await call("/v1/computers/local/actions", {
        action: "click",
        target: { elementId: "el-1" },
        approvedScopes: ["UI_CONTROL"],
        ...approval,
      })
      expect(before.status).toBe(200)
      expect(harness.clickCount()).toBe(1)

      const stopped = await call("/v1/computers/local/stop", { reason: "user pressed stop", sessionId: "session-1" })
      expect(stopped.status).toBe(200)
      expect((stopped.body.result as { status: string }).status).toBe("cancelled")
      expect(harness.releaseCalls()).toBe(1)

      const blocked = await call("/v1/computers/local/actions", {
        action: "click",
        target: { elementId: "el-1" },
        approvedScopes: ["UI_CONTROL"],
        ...approval,
      })
      expect(blocked.status).toBe(409)
      expect((blocked.body.result as { error?: { code?: string } }).error?.code).toBe("action_cancelled")

      const connected = await call("/v1/computers/local/connect", {})
      expect(connected.status).toBe(200)
      const resumed = await call("/v1/computers/local/actions", {
        action: "click",
        target: { elementId: "el-1" },
        approvedScopes: ["UI_CONTROL"],
        ...approval,
      })
      expect(resumed.status).toBe(200)
      expect(harness.clickCount()).toBe(2)
    })
  })

  test("stop aborts a running batch", async () => {
    const harness = createCommandDriver()
    harness.holdClicks()
    await withCommandServer(harness, async (_server, call) => {
      const batch = call("/v1/computers/local/do", {
        steps: [
          { action: "click", target: { elementId: "el-1" } },
          { action: "click", target: { elementId: "el-1" } },
        ],
        approvedScopes: ["UI_CONTROL"],
        ...approval,
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      await call("/v1/computers/local/stop", { reason: "stop batch" })
      harness.releaseClicks()
      const result = await batch
      expect(result.status).toBe(200)
      const body = result.body.result as { completed: number; total: number; message: string }
      expect(body.total).toBe(2)
      expect(body.completed).toBeLessThan(2)
      expect(body.message).toContain("stopped")
    })
  })

  test("stop cancels an in-flight step without waiting for the driver", async () => {
    const harness = createCommandDriver()
    harness.holdClicks()
    await withCommandServer(harness, async (_server, call) => {
      const batch = call("/v1/computers/local/do", {
        steps: [
          { action: "click", target: { elementId: "el-1" } },
          { action: "click", target: { elementId: "el-1" } },
        ],
        approvedScopes: ["UI_CONTROL"],
        ...approval,
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      await call("/v1/computers/local/stop", { reason: "stop batch" })
      // The held click is deliberately NOT released: cancellation must not
      // wait for the in-flight driver call to finish.
      const result = await Promise.race([
        batch,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("batch did not cancel")), 1500)),
      ])
      const body = result.body.result as { message: string }
      expect(body.message).toContain("stopped")
      harness.releaseClicks()
    })
  })
})

describe("read_value and wait", () => {
  test("read_value returns the focused control value", async () => {
    const harness = createCommandDriver()
    await withCommandServer(harness, async (_server, call) => {
      const response = await call("/v1/computers/local/actions", { action: "read_value" })
      expect(response.status).toBe(200)
      const metadata = (response.body.result as { metadata?: { value?: unknown; role?: string } }).metadata
      expect(metadata?.value).toBe("ls -la")
      expect(metadata?.role).toBe("textbox")
    })
  })

  test("wait is forwarded to the driver as a wait action", async () => {
    const harness = createCommandDriver()
    await withCommandServer(harness, async (_server, call) => {
      const response = await call("/v1/computers/local/actions", { action: "wait", amount: 10 })
      expect(response.status).toBe(200)
      expect(harness.lastAction()?.type).toBe("wait")
    })
  })
})


for (const selector of [undefined, "auto"] as const) {
test(`shell approval confirms and binds the resolved credential (${selector ?? "omitted"})`, async () => {
  const harness = createCommandDriver()
  await withCommandServer(harness, async (_server, call) => {
    await call("/v1/computers/local/credentials", { name: "first", secret: "first-secret", rules: [{ kind: "command", match: "whoami" }] })
    const operation = { action: "run_command", resources: ["whoami"], command: "whoami", computerId: "local", maxUses: 3, ...(selector === undefined ? {} : { credential: selector }) }
    const preview = await call("/v1/permissions/approve", operation)
    expect(preview.status).toBe(428)
    expect(JSON.stringify(preview.body)).not.toContain("first-secret")
    const issued = await call("/v1/permissions/approve", { ...operation, resolvedCredential: preview.body.credential })
    expect(issued.status).toBe(200)
    const fingerprint = (issued.body.approval as { fingerprint: string }).fingerprint
    // A bound operator approval intentionally overrides the denied SECRETS scope.
    const approved = await call("/v1/computers/local/actions", { action: "run_command", command: "whoami", ...(selector === undefined ? {} : { credential: selector }), approvalFingerprint: fingerprint })
    expect(approved.status).toBe(200)
    await call("/v1/computers/local/credentials", { name: "second", secret: "second-secret", rules: [{ kind: "command", match: "whoami" }] })
    const denied = await call("/v1/computers/local/actions", { action: "run_command", command: "whoami", ...(selector === undefined ? {} : { credential: selector }), approvalFingerprint: fingerprint })
    expect(denied.status).toBe(403)
    expect(harness.commands).toHaveLength(1)
  })
})
}
