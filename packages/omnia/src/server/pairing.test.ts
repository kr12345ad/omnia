import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PairingManager, normalizePairingCode, pairingCodeHash, pairingDiscoveryMac } from "../pairing"
import { sessionProof } from "./api"
import { startOmniaServer } from "./server"
import { RemoteAgent, createRemoteKeyPair, remoteAuthHeaders } from "../remote"
import type { HostDriver } from "../daemon"
import type { ServerComputerDriver } from "./computers"
import type { ActionResult, ComputerAction, Observation } from "../protocol"

function createLocalDriver(): ServerComputerDriver {
  return {
    id: "local",
    backend: "test",
    getInfo: async () => ({ id: "local", name: "Local", platform: "linux", connected: true }),
    capabilities: () => [],
    observe: async (): Promise<Observation> => ({ id: "local-obs", elements: [] }),
    find: async () => ({ matches: [] }),
    execute: async (): Promise<ActionResult> => ({ success: true, status: "success", message: "ok" }),
  }
}

function createRemoteHost(): { driver: HostDriver; lastAction: () => ComputerAction | undefined } {
  let lastAction: ComputerAction | undefined
  const driver: HostDriver = {
    id: "remote-host",
    backend: "test-remote",
    capabilities: [{ capability: "accessibility", status: "available" }],
    getInfo: async () => ({
      id: "remote-host",
      name: "Remote Test",
      platform: "linux",
      architecture: "x64",
      connected: true,
    }),
    observe: async (): Promise<Observation> => ({
      id: "remote-obs",
      elements: [
        {
          id: "el-1",
          role: "button",
          name: "Go",
          bounds: { x: 10, y: 10, width: 40, height: 20 },
          actions: ["click"],
          states: [],
        },
      ],
    }),
    find: async (request) => ({ query: request.query, matches: [] }),
    execute: async (action): Promise<ActionResult> => {
      lastAction = action
      return { success: true, status: "success", message: `Executed ${action.type}.` }
    },
    runCommand: async () => ({
      success: true,
      status: "success",
      message: "Command exited with code 0.",
      command: { exitCode: 0, stdout: "remote-output", stderr: "", truncated: false, timedOut: false, durationMs: 1 },
    }),
    revalidateTarget: async () => ({ valid: true }),
  }
  return { driver, lastAction: () => lastAction }
}

async function withServer<T>(
  fn: (server: Awaited<ReturnType<typeof startOmniaServer>>) => Promise<T>,
  now?: () => number,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "omnia-pairing-"))
  const server = await startOmniaServer({
    drivers: [createLocalDriver()],
    credentialsFile: join(dir, "credentials.json"),
    authFile: join(dir, "auth.json"),
    superskillFile: join(dir, "superskills.json"),
    memoryFile: join(dir, "memories.json"),
    computerUseFile: join(dir, "computer-use.json"),
    pairingsFile: join(dir, "pairings.json"),
    ...(now === undefined ? {} : { now }),
  })
  try {
    return await fn(server)
  } finally {
    await server.stop()
  }
}

const auth = (server: { token: string }, sessionId?: string) => ({
  authorization: `Bearer ${server.token}`,
  "content-type": "application/json",
  ...(sessionId === undefined ? {} : { "x-omnia-session-proof": sessionProof(server.token, sessionId) }),
})

describe("pairing manager", () => {
  test("creates codes that are single use and expire", () => {
    let now = 1000
    const manager = new PairingManager({ now: () => now, ttlMs: 1000 })
    const offer = manager.create({ name: "Office PC" })
    expect(offer.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(normalizePairingCode(offer.code.toLowerCase().replace("-", " "))).toBe(offer.code)
    expect(manager.get(offer.code)?.name).toBe("Office PC")
    expect(manager.claim(offer.code)?.code).toBe(offer.code)
    expect(manager.claim(offer.code)).toBeUndefined()

    const expiring = manager.create()
    now += 1001
    expect(manager.claim(expiring.code)).toBeUndefined()
    expect(manager.list()).toHaveLength(0)
  })

  test("cancels offers", () => {
    const manager = new PairingManager()
    const offer = manager.create()
    expect(manager.cancel(offer.code)).toBe(true)
    expect(manager.cancel(offer.code)).toBe(false)
  })

  test("distinguishes valid, expired, and unknown codes", () => {
    let now = 1000
    const manager = new PairingManager({ now: () => now, ttlMs: 1000 })
    const offer = manager.create()
    expect(manager.status(offer.code)).toBe("valid")
    expect(manager.status("ZZZZ-ZZZZ")).toBe("unknown")
    now += 1001
    expect(manager.status(offer.code)).toBe("expired")
    expect(manager.claim(offer.code)).toBeUndefined()
  })

  test("persists offers across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-pairing-file-"))
    const file = join(dir, "pairings.json")
    const first = new PairingManager({ file })
    const offer = first.create({ name: "Office PC" })
    const second = new PairingManager({ file })
    expect(second.claim(offer.code)?.name).toBe("Office PC")
    expect(second.claim(offer.code)).toBeUndefined()
    const third = new PairingManager({ file })
    expect(third.status(offer.code)).toBe("unknown")
  })

  test("drops expired offers on load", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-pairing-expired-"))
    const file = join(dir, "pairings.json")
    let now = 1000
    const first = new PairingManager({ file, now: () => now, ttlMs: 1000 })
    const offer = first.create()
    now += 2000
    const second = new PairingManager({ file, now: () => now })
    expect(second.status(offer.code)).toBe("expired")
    expect(second.list()).toHaveLength(0)
    expect(second.status(offer.code)).toBe("unknown")
  })
})

describe("pairing route robustness", () => {
  test("answers malformed pairing-code escapes with 400", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/pair/%ZZ`, { method: "DELETE", headers: auth(server) })
      expect(response.status).toBe(400)
    })
  })

  test("answers malformed remote computer-id escapes with 400", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/%ZZ/remote/next`, { method: "POST" })
      expect(response.status).toBe(400)
    })
  })
})

describe("pairing discovery authentication", () => {
  test("signs discovery answers with the pairing code, not the broadcast hash", () => {
    const code = "ABCD-EFGH"
    const hash = pairingCodeHash(code)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(pairingCodeHash(code.toLowerCase().replace("-", " "))).toBe(hash)
    const mac = pairingDiscoveryMac(code, "nonce-1", "http://192.168.1.5:1234")
    expect(pairingDiscoveryMac(code, "nonce-1", "http://192.168.1.5:1234")).toBe(mac)
    expect(pairingDiscoveryMac(code, "nonce-2", "http://192.168.1.5:1234")).not.toBe(mac)
    expect(pairingDiscoveryMac("WXYZ-9876", "nonce-1", "http://192.168.1.5:1234")).not.toBe(mac)
    expect(mac).not.toContain(code)
  })
})

describe("computer pairing", () => {
  test("pairs a remote agent and routes actions to it", async () => {
    const remoteHost = createRemoteHost()
    await withServer(async (server) => {
      const created = await fetch(`${server.url}/v1/computers/pair`, {
        method: "POST",
        headers: auth(server),
        body: JSON.stringify({ name: "Workshop PC" }),
      })
      expect(created.status).toBe(200)
      const offer = (await created.json()) as { pairing: { code: string }; serverUrl: string }
      expect(offer.serverUrl.startsWith("http://127.0.0.1:")).toBe(true)

      const keys = createRemoteKeyPair()
      const claimed = await fetch(`${server.url}/v1/computers/pair/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: offer.pairing.code,
          name: "Workshop PC",
          platform: "linux",
          architecture: "x64",
          info: { id: "remote-host", name: "Workshop PC", platform: "linux", connected: true },
          capabilities: remoteHost.driver.capabilities,
          publicKey: keys.publicKey,
        }),
      })
      expect(claimed.status).toBe(200)
      const claim = (await claimed.json()) as { computerId: string; token: string }
      expect(claim.computerId.startsWith("remote-")).toBe(true)

      const listed = await fetch(`${server.url}/v1/computers`, { headers: auth(server) })
      const computers = ((await listed.json()) as { computers: Array<{ id: string; backend: string }> }).computers
      expect(computers.some((computer) => computer.id === claim.computerId && computer.backend === "remote")).toBe(true)

      const agent = new RemoteAgent({
        serverUrl: server.url,
        computerId: claim.computerId,
        token: claim.token,
        driver: remoteHost.driver,
        plan: "pro",
        keys,
      })
      agent.start()
      try {
        const acted = await fetch(`${server.url}/v1/computers/${claim.computerId}/actions`, {
          method: "POST",
          headers: auth(server, "pairing-test"),
          body: JSON.stringify({
            action: "click",
            target: { elementId: "el-1" },
            approve: true,
            approvedBy: "session:test",
            approvedScopes: ["UI_CONTROL"],
            sessionId: "pairing-test",
          }),
        })
        expect(acted.status).toBe(200)
        const result = (await acted.json()) as { result: { success: boolean } }
        expect(result.result.success).toBe(true)
        expect(remoteHost.lastAction()?.type).toBe("click")

        const ran = await fetch(`${server.url}/v1/computers/${claim.computerId}/actions`, {
          method: "POST",
          headers: auth(server, "pairing-test"),
          body: JSON.stringify({
            action: "run_command",
            command: "echo remote",
            approve: true,
            approvedBy: "session:test",
            approvedScopes: ["PROCESS_EXECUTE"],
            sessionId: "pairing-test",
          }),
        })
        const command = (await ran.json()) as { result: { command?: { stdout?: string } } }
        expect(command.result.command?.stdout).toBe("remote-output")
      } finally {
        agent.stop()
      }

      const byeUrl = `${server.url}/v1/computers/${claim.computerId}/remote/bye`
      const bye = await fetch(byeUrl, {
        method: "POST",
        headers: remoteAuthHeaders({
          token: claim.token,
          computerId: claim.computerId,
          method: "POST",
          url: byeUrl,
          // The agent already spent the last few milliseconds signing its own
          // requests, and the server refuses a timestamp a computer reused.
          timestampMs: Date.now() + 1_000,
          keys: keys.privateKey,
        }),
      })
      expect(bye.status).toBe(200)
      const after = await fetch(`${server.url}/v1/computers`, { headers: auth(server) })
      const remaining = ((await after.json()) as { computers: Array<{ id: string }> }).computers
      expect(remaining.some((computer) => computer.id === claim.computerId)).toBe(false)
    })
  })

  test("rejects reused codes, wrong remote tokens, and cancelled offers", async () => {
    await withServer(async (server) => {
      const created = await fetch(`${server.url}/v1/computers/pair`, {
        method: "POST",
        headers: auth(server),
        body: JSON.stringify({}),
      })
      const offer = (await created.json()) as { pairing: { code: string } }

      const cancelled = await fetch(`${server.url}/v1/computers/pair/${offer.pairing.code}`, {
        method: "DELETE",
        headers: auth(server),
      })
      expect(cancelled.status).toBe(200)
      const afterCancel = await fetch(`${server.url}/v1/computers/pair/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: offer.pairing.code, name: "Nope", platform: "linux" }),
      })
      expect(afterCancel.status).toBe(404)

      const second = await fetch(`${server.url}/v1/computers/pair`, {
        method: "POST",
        headers: auth(server),
        body: JSON.stringify({}),
      })
      const secondOffer = (await second.json()) as { pairing: { code: string } }
      const claimed = await fetch(`${server.url}/v1/computers/pair/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: secondOffer.pairing.code, name: "PC", platform: "linux" }),
      })
      const claim = (await claimed.json()) as { computerId: string }
      const reused = await fetch(`${server.url}/v1/computers/pair/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: secondOffer.pairing.code, name: "PC", platform: "linux" }),
      })
      expect(reused.status).toBe(404)

      const unauthorized = await fetch(
        `${server.url}/v1/computers/${claim.computerId}/remote/commands?wait=0`,
        { headers: { authorization: "Bearer wrong-token" } },
      )
      expect(unauthorized.status).toBe(401)

      const claimWithoutToken = await fetch(`${server.url}/v1/computers`, { headers: auth(server) })
      expect(claimWithoutToken.status).toBe(200)
    })
  })

  test("answers expired codes with 410 and unknown codes with 404", async () => {
    let now = 5_000_000
    await withServer(async (server) => {
      const created = await fetch(`${server.url}/v1/computers/pair`, {
        method: "POST",
        headers: auth(server),
        body: JSON.stringify({}),
      })
      expect(created.status).toBe(200)
      const offer = (await created.json()) as { pairing: { code: string; expiresAt: number } }
      now += 11 * 60 * 1000
      const expired = await fetch(`${server.url}/v1/computers/pair/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: offer.pairing.code, name: "Late", platform: "linux" }),
      })
      expect(expired.status).toBe(410)
      const expiredBody = (await expired.json()) as { code?: string }
      expect(expiredBody.code).toBe("pairing_expired")

      const unknown = await fetch(`${server.url}/v1/computers/pair/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "ZZZZ-ZZZZ", name: "Nope", platform: "linux" }),
      })
      expect(unknown.status).toBe(404)
      const unknownBody = (await unknown.json()) as { code?: string }
      expect(unknownBody.code).toBe("pairing_not_found")
    }, () => now)
  })
})
