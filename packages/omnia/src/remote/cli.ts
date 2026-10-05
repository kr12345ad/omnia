import { hostname } from "node:os"
import { createDarwinHostDriver, createHostDriver, createWindowsHostDriver, LinuxHostDriver } from "../daemon"
import type { HostDriver } from "../daemon"
import { parsePairingCode } from "../pairing"
import { RemoteAgent } from "./agent"
import { RemoteEntitlementGate } from "./entitlement"
import { fileRemoteKeyStorage, loadOrCreateRemoteKeyPair } from "./keys"
import { remoteAuthHeaders } from "./signing"

function parseArgs(argv: readonly string[]): { command: string; flags: Record<string, string> } {
  const flags: Record<string, string> = {}
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=")
      if (inline !== undefined) flags[key!] = inline
      else {
        const next = argv[index + 1]
        if (next !== undefined && !next.startsWith("--")) {
          flags[key!] = next
          index += 1
        } else {
          flags[key!] = "true"
        }
      }
      continue
    }
    positional.push(arg)
  }
  return { command: positional[0] ?? "pair", flags }
}

function platformDriver(): HostDriver | undefined {
  if (process.platform === "darwin") return createDarwinHostDriver()
  if (process.platform === "win32") return createWindowsHostDriver()
  const host = new LinuxHostDriver()
  if (!host.available) return undefined
  return createHostDriver(host)
}

const usage =
  "Usage: bun packages/omnia/src/remote/cli.ts pair --code <pairing-code> [--url <server-url>] [--name <computer-name>] [--token <server-token>] [--profile <github-id>]"

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2))
  if (command !== "pair") {
    console.error(usage)
    process.exit(1)
  }
  let url = flags.url
  let code = flags.code
  if (code !== undefined && url === undefined) {
    const parsed = parsePairingCode(code)
    if (parsed !== undefined) {
      url = parsed.serverUrl
      code = parsed.code
    }
  }
  if (url === undefined || code === undefined) {
    console.error(usage)
    process.exit(1)
  }
  const driver = platformDriver()
  if (driver === undefined) {
    console.error("No computer runtime is available on this machine.")
    process.exit(1)
  }
  const base = url.replace(/\/+$/, "")
  // Checked BEFORE the claim, because the claim consumes the single-use pairing
  // code: a computer past the plan's allowance is refused here with the reason,
  // so the code survives an upgrade and the operator can retry it.
  const allowance = await RemoteEntitlementGate.fromEnv({
    endpoint: base,
    token: flags.token,
    profileId: flags.profile,
    log: (message) => console.log(`[omnia-remote] ${message}`),
  }).authorizeComputer()
  if (!allowance.allowed) {
    // The operator gets the server's own sentence about the refusal, the same
    // way a claim the control plane turns down is reported below.
    console.error(allowance.reason)
    process.exit(1)
  }
  const info = await driver.getInfo()
  const keys = await loadOrCreateRemoteKeyPair(fileRemoteKeyStorage())
  const response = await fetch(`${base}/v1/computers/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      name: flags.name ?? hostname(),
      platform: info.platform,
      ...(info.architecture === undefined ? {} : { architecture: info.architecture }),
      info,
      capabilities: driver.capabilities ?? [],
      publicKey: keys.publicKey,
    }),
  })
  const body = (await response.json()) as { ok?: boolean; computerId?: string; token?: string; error?: string }
  if (!response.ok || body.ok !== true || body.computerId === undefined || body.token === undefined) {
    console.error(body.error ?? `Pairing failed with HTTP ${response.status}.`)
    process.exit(1)
  }
  const computerId = body.computerId
  const token = body.token
  const agent = new RemoteAgent({
    serverUrl: base,
    computerId,
    token,
    driver,
    keys,
    // An unconfirmed plan is left unset so the session runs under the free
    // ceiling instead of an unbounded one; a paid ceiling only comes from a
    // plan the control plane actually named.
    ...(allowance.planKnown ? { plan: allowance.plan } : {}),
    log: (message) => console.log(`[omnia-remote] ${message}`),
  })
  agent.start()
  console.log(
    `Paired as ${computerId}. This computer is now available to the Omnia Server. Press Ctrl+C to disconnect.`,
  )
  const shutdown = async () => {
    agent.stop()
    const byeUrl = `${base}/v1/computers/${computerId}/remote/bye`
    await fetch(byeUrl, {
      method: "POST",
      headers: remoteAuthHeaders({
        token,
        computerId,
        method: "POST",
        url: byeUrl,
        baseUrl: base,
        timestampMs: Date.now(),
        keys: keys.privateKey,
      }),
    }).catch(() => undefined)
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}

void main()
