import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { isOmniaScope, type OmniaScope } from "../server/permissions"
import type { Superskill, SuperskillBridge, SuperskillMethod, SuperskillSummary } from "./types"

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/

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

function parseScopes(value: unknown, field: string): readonly OmniaScope[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of permission scopes.`)
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
    ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
  }
}

function parseMethod(value: unknown): SuperskillMethod {
  const record = asRecord(value)
  if (record === undefined) throw new Error("each method must be an object.")
  return {
    name: requireString(record.name, "method.name"),
    description: requireString(record.description, "method.description"),
    ...(asRecord(record.parameters) === undefined ? {} : { parameters: asRecord(record.parameters)! }),
    ...(parseScopes(record.scopes, "method.scopes") === undefined
      ? {}
      : { scopes: parseScopes(record.scopes, "method.scopes")! }),
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
  return {
    id,
    name: requireString(record.name, "name"),
    description: requireString(record.description, "description"),
    instructions: typeof record.instructions === "string" ? record.instructions : "",
    enabled: record.enabled !== false,
    ...(optionalString(record.version) === undefined ? {} : { version: optionalString(record.version)! }),
    ...(optionalString(record.author) === undefined ? {} : { author: optionalString(record.author)! }),
    ...(parseScopes(record.scopes, "scopes") === undefined ? {} : { scopes: parseScopes(record.scopes, "scopes")! }),
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
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { superskills?: unknown }
      const list = Array.isArray(parsed.superskills) ? parsed.superskills : []
      for (const item of list) {
        const skill = parseSuperskill(item)
        this.skills.set(skill.id, skill)
      }
    } catch {
      // A malformed file should never take the server down; it is reported on next save.
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify({ superskills: [...this.skills.values()] }, null, 2))
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
