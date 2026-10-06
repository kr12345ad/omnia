import { homedir } from "node:os"
import { join } from "node:path"
import { createHostDriver, LinuxHostDriver } from "../src/daemon"
import type { ActionResult } from "../src/protocol"

// Latency harness for the Cua action path. It is intentionally manual: run it
// on a Linux desktop or against a paired remote computer through the hosted
// control plane. It is not part of any test suite.

interface BenchObservation {
  elements: number
  truncated: boolean
}

interface BenchFind {
  matches: number
}

interface BenchAction {
  success: boolean
  verified: boolean
}

interface BenchTarget {
  readonly label: string
  info(): Promise<string>
  observe(): Promise<BenchObservation>
  find(query: string): Promise<BenchFind>
  type(text: string): Promise<BenchAction>
  key(key: string): Promise<BenchAction>
  dispose(): Promise<void>
}

const usage =
  "Usage: bun script/cua-bench.ts [--remote] [--url <control-plane-url>] [--token <token>] [--computer <computer-id>] [--find <query>] [--type <text>] [--key <key>]"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function parseArgs(argv: readonly string[]): { flags: Map<string, string | true>; error?: string } {
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith("--")) return { flags, error: `Unexpected argument: ${arg}` }
    const [name, inline] = arg.slice(2).split("=")
    if (name === undefined || name.length === 0) return { flags, error: `Unexpected argument: ${arg}` }
    if (inline !== undefined) {
      flags.set(name, inline)
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next)
      index += 1
      continue
    }
    flags.set(name, true)
  }
  return { flags }
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === "string" && value.length > 0 ? value : undefined
}

async function localTarget(): Promise<BenchTarget> {
  if (process.platform !== "linux") throw new Error("Local mode supports Linux only; use --remote.")
  const host = new LinuxHostDriver()
  if (!host.available) throw new Error("The Linux host is unavailable; is DISPLAY set?")
  const driver = createHostDriver(host)
  return {
    label: `local ${driver.backend}`,
    info: async () => {
      const info = await driver.getInfo()
      return `${info.platform} backend=${driver.backend}`
    },
    observe: async () => {
      const observation = await driver.observe()
      return {
        elements: (observation.elements ?? []).length,
        truncated: observation.metadata?.truncated === true,
      }
    },
    find: async (query) => {
      const result = await driver.find({ query, limit: 5 })
      return { matches: (result.matches ?? result.results ?? []).length }
    },
    type: async (text) => summarize(await driver.execute({ type: "type", text })),
    key: async (key) => summarize(await driver.execute({ type: "key", key })),
    dispose: async () => {
      driver.dispose?.()
    },
  }
}

interface RemoteOptions {
  readonly url: string
  readonly token: string
  readonly computer: string
}

function remoteTarget(options: RemoteOptions): BenchTarget {
  const base = options.url.replace(/\/+$/, "")
  const computerPath = `/v1/computers/${encodeURIComponent(options.computer)}`
  const call = async (path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(300_000),
    })
    const text = await response.text()
    const parsed: unknown = text.length === 0 ? {} : JSON.parse(text)
    if (!isRecord(parsed)) throw new Error(`Unexpected response from ${path}.`)
    if (!response.ok || parsed.ok !== true) {
      const error =
        typeof parsed.error === "string" ? parsed.error : `Request to ${path} failed with HTTP ${response.status}.`
      throw new Error(error)
    }
    return parsed
  }
  const approved = {
    approve: true,
    approvedBy: "cua-bench",
    approvedScopes: ["UI_READ", "UI_CONTROL", "KEYBOARD", "POINTER", "SCREEN_READ"],
  }
  const action = async (body: Record<string, unknown>): Promise<BenchAction> => {
    const record = await call(`${computerPath}/actions`, { ...body, ...approved })
    if (!isRecord(record.result)) throw new Error("The control plane returned no action result.")
    return {
      success: record.result.success === true,
      verified: isRecord(record.result.verification) ? record.result.verification.verified === true : false,
    }
  }
  return {
    label: `remote ${options.computer} via ${base}`,
    info: async () => {
      const record = await call("/v1/computers")
      const computers = Array.isArray(record.computers) ? record.computers.filter(isRecord) : []
      const computer = computers.find((entry) => entry.id === options.computer)
      if (computer === undefined) return `computer ${options.computer}`
      return `${text(computer.platform, "unknown")} backend=${text(computer.backend, "remote")}`
    },
    observe: async () => {
      const record = await call(`${computerPath}/observe`, approved)
      if (!isRecord(record.observation)) throw new Error("The control plane returned no observation.")
      const elements = Array.isArray(record.observation.elements) ? record.observation.elements.length : 0
      const metadata = isRecord(record.observation.metadata) ? record.observation.metadata : undefined
      return { elements, truncated: metadata?.truncated === true }
    },
    find: async (query) => {
      const record = await call(`${computerPath}/find`, { query, limit: 5, ...approved })
      if (!isRecord(record.result)) throw new Error("The control plane returned no find result.")
      const matches = Array.isArray(record.result.matches)
        ? record.result.matches
        : Array.isArray(record.result.results)
          ? record.result.results
          : []
      return { matches: matches.length }
    },
    type: (text) => action({ action: "type", text }),
    key: (key) => action({ action: "key", key }),
    dispose: async () => {},
  }
}

function summarize(result: ActionResult): BenchAction {
  return { success: result.success, verified: result.verification?.verified ?? false }
}

async function time<T>(label: string, fn: () => Promise<T>, print: (result: T) => string): Promise<void> {
  const started = performance.now()
  try {
    const result = await fn()
    console.log(`${label}: ${Math.round(performance.now() - started)}ms ${print(result)}`)
  } catch (error) {
    console.log(
      `${label}: ERROR ${error instanceof Error ? error.message : String(error)} (${Math.round(performance.now() - started)}ms)`,
    )
  }
}

async function defaultComputerId(): Promise<string | undefined> {
  const names = ["io.omnia.desktop", "io.omnia.desktop.dev"]
  for (const name of names) {
    const parsed: unknown = await Bun.file(join(homedir(), ".config", name, "control-plane-computer.json"))
      .json()
      .catch(() => undefined)
    if (isRecord(parsed) && typeof parsed.computerId === "string" && parsed.computerId.length > 0) {
      return parsed.computerId
    }
  }
  return undefined
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.error !== undefined) {
    console.error(parsed.error)
    console.error(usage)
    process.exit(1)
  }
  const flags = parsed.flags
  if (flags.has("help")) {
    console.log(usage)
    return
  }
  const remote = flags.has("remote")
  const url = stringFlag(flags, "url") ?? process.env.OMNIA_CONTROL_PLANE_URL?.trim()
  const token =
    stringFlag(flags, "token") ?? process.env.OMNIA_CONTROL_PLANE_TOKEN?.trim() ?? process.env.OMNIA_TOKEN?.trim()
  const computer = stringFlag(flags, "computer") ?? process.env.OMNIA_COMPUTER_ID?.trim() ?? (await defaultComputerId())
  const query = stringFlag(flags, "find") ?? "Bold"
  const text = stringFlag(flags, "type") ?? "Hello world"
  const key = stringFlag(flags, "key") ?? "Return"

  const target = remote
    ? (() => {
        if (url === undefined || token === undefined || computer === undefined) {
          throw new Error("Remote mode needs --url, --token, and --computer (or the matching environment).")
        }
        return remoteTarget({ url, token, computer })
      })()
    : await localTarget()

  try {
    console.log(`target: ${target.label}`)
    console.log(`info: ${await target.info()}`)
    await time(
      "observe cold",
      () => target.observe(),
      (result) => `elements=${result.elements} truncated=${result.truncated}`,
    )
    await time(
      "observe warm",
      () => target.observe(),
      (result) => `elements=${result.elements} truncated=${result.truncated}`,
    )
    await time(
      `find first "${query}"`,
      () => target.find(query),
      (result) => `matches=${result.matches}`,
    )
    await time(
      `find warm "${query}"`,
      () => target.find(query),
      (result) => `matches=${result.matches}`,
    )
    await time(
      `type "${text}"`,
      () => target.type(text),
      (result) => `success=${result.success} verified=${result.verified}`,
    )
    await time(
      `key "${key}"`,
      () => target.key(key),
      (result) => `success=${result.success} verified=${result.verified}`,
    )
  } finally {
    await target.dispose()
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
process.exit(0)
