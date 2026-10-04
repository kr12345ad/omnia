import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { isOmniaScope, type OmniaScope } from "../server/permissions"
import type { Superskill, SuperskillBridge, SuperskillMethod, SuperskillSummary } from "./types"

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 300000

export interface SuperskillRegistryOptions {
  readonly file?: string
}

export function defaultSuperskillFile(): string {
  return join(homedir(), ".local", "share", "omnia", "superskills.json")
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required.`)
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

// An empty scopes array must never mean "no scopes": return undefined so the
// server applies the bridge-type default (PROCESS_EXECUTE for stdio, NETWORK
// for http). The persisted file therefore never contains `scopes: []`.
function parseScopes(value: unknown, field: string): readonly OmniaScope[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of permission scopes.`)
  if (value.length === 0) return undefined
  return value.map((scope) => {
    if (!isOmniaScope(scope)) throw new Error(`${field} contains an unknown permission scope: ${String(scope)}`)
    return scope
  })
}

function parseBridge(value: unknown): SuperskillBridge {
  const record = asRecord(value)
  if (record === undefined) throw new Error("bridge is required.")
  const type = record.type
  if (type !== "stdio" && type !== "http") throw new Error('bridge.type must be "stdio" or "http".')
  const env = asRecord(record.env)
  const timeoutMs =
    typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs)
      ? Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(record.timeoutMs)))
      : undefined
  return {
    type,
    ...(optionalString(record.command) === undefined ? {} : { command: optionalString(record.command)! }),
    ...(optionalString(record.url) === undefined ? {} : { url: optionalString(record.url)! }),
    ...(env === undefined
      ? {}
      : {
          env: Object.fromEntries(
            Object.entries(env).flatMap(([key, item]) =>
              typeof item === "string" ? [[key, item] as const] : [],
            ),
          ),
        }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

function parseMethod(value: unknown): SuperskillMethod {
  const record = asRecord(value)
  if (record === undefined) throw new Error("each method must be an object.")
  const scopes = parseScopes(record.scopes, "method.scopes")
  return {
    name: requireString(record.name, "method.name"),
    description: requireString(record.description, "method.description"),
    ...(asRecord(record.parameters) === undefined ? {} : { parameters: asRecord(record.parameters)! }),
    ...(scopes === undefined ? {} : { scopes }),
  }
}

export function parseSuperskill(value: unknown): Superskill {
  const record = asRecord(value)
  if (record === undefined) throw new Error("A superskill must be an object.")
  const id = requireString(record.id, "id")
  if (!ID_PATTERN.test(id)) {
    throw new Error("id must be a short lowercase slug such as libreoffice-bridge.")
  }
  const bridge = parseBridge(record.bridge)
  if (bridge.type === "stdio" && bridge.command === undefined) {
    throw new Error("a stdio bridge needs a command.")
  }
  if (bridge.type === "http" && bridge.url === undefined) {
    throw new Error("an http bridge needs a url.")
  }
  const methods = Array.isArray(record.methods) ? record.methods.map(parseMethod) : []
  if (methods.length === 0) throw new Error("at least one method is required.")
  const names = new Set<string>()
  for (const method of methods) {
    if (names.has(method.name)) throw new Error(`duplicate method name: ${method.name}`)
    names.add(method.name)
  }
  const scopes = parseScopes(record.scopes, "scopes")
  return {
    id,
    name: requireString(record.name, "name"),
    description: requireString(record.description, "description"),
    instructions: typeof record.instructions === "string" ? record.instructions : "",
    enabled: record.enabled !== false,
    ...(optionalString(record.version) === undefined ? {} : { version: optionalString(record.version)! }),
    ...(optionalString(record.author) === undefined ? {} : { author: optionalString(record.author)! }),
    ...(scopes === undefined ? {} : { scopes }),
    bridge,
    methods,
  }
}

export function summarizeSuperskill(skill: Superskill): SuperskillSummary {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    enabled: skill.enabled,
    ...(skill.version === undefined ? {} : { version: skill.version }),
    ...(skill.author === undefined ? {} : { author: skill.author }),
    bridgeType: skill.bridge.type,
    methods: skill.methods.map((method) => method.name),
  }
}

export class SuperskillRegistry {
  private readonly file: string
  private skills = new Map<string, Superskill>()

  constructor(options: SuperskillRegistryOptions = {}) {
    this.file = options.file ?? defaultSuperskillFile()
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    let parsed: { superskills?: unknown }
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8")) as { superskills?: unknown }
    } catch {
      parsed = {}
    }
    if (!Array.isArray(parsed.superskills)) {
      // A torn write must never masquerade as an empty registry: the first save
      // after a crash would otherwise discard every skill, including the bridge
      // environment secrets. Keep the bytes aside and refuse to start instead.
      try {
        renameSync(this.file, `${this.file}.corrupt`)
      } catch {
        // Nothing to preserve, or the directory is not writable.
      }
      throw new Error(`${this.file} is not a readable Omnia superskill file; it was kept at ${this.file}.corrupt.`)
    }
    // Per-entry parse: one malformed skill must not silently drop the rest.
    for (const item of parsed.superskills) {
      try {
        const skill = parseSuperskill(item)
        this.skills.set(skill.id, skill)
      } catch {
        // Skip only the malformed entry; valid skills still load.
      }
    }
  }

  private persist(): void {
    const directory = dirname(this.file)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${basename(this.file)}.${randomUUID()}.tmp`)
    try {
      // The file can contain bridge env secrets (API keys/tokens), so it is
      // written to its own fresh 0600 file and `wx` never follows a planted
      // symlink the way a fixed `<file>.tmp` name would.
      const handle = openSync(temporary, "wx", 0o600)
      try {
        writeFileSync(handle, JSON.stringify({ superskills: [...this.skills.values()] }, null, 2))
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
      // rename(2) inside one directory is atomic, so a crash or a full disk
      // leaves either the previous registry or this one, never a torn mix.
      renameSync(temporary, this.file)
    } catch (error) {
      // A temp file left behind is dead weight holding secrets; never keep one.
      try {
        unlinkSync(temporary)
      } catch {
        // Already gone, or the directory is gone with it.
      }
      throw error
    }
    // Rename keeps the temp file's mode, but an existing registry may predate
    // this call with looser permissions.
    chmodSync(this.file, 0o600)
    try {
      fsyncDirectory(directory)
    } catch {
      // The rename already landed; only its durability across a power loss is
      // weakened, which must not be reported as a failed save.
    }
  }

  list(): Superskill[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  enabled(): Superskill[] {
    return this.list().filter((skill) => skill.enabled)
  }

  get(id: string): Superskill | undefined {
    return this.skills.get(id)
  }

  save(input: unknown): Superskill {
    const skill = parseSuperskill(input)
    this.skills.set(skill.id, skill)
    this.persist()
    return skill
  }

  remove(id: string): boolean {
    const removed = this.skills.delete(id)
    if (removed) this.persist()
    return removed
  }

  get path(): string {
    return this.file
  }
}

// The rename that swapped the registry in is only durable once the directory
// entry itself is on disk.
function fsyncDirectory(directory: string): void {
  const handle = openSync(directory, "r")
  try {
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
}
