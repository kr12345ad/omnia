export * as HandoffDormant from "./dormant"

import path from "path"
import { Glob } from "@opencode-ai/core/util/glob"
import { ConfigMarkdown } from "@/config/markdown"

/**
 * Metadata-only view of a dormant sub-agent. Scanning never resolves the agent
 * through Agent.Service, never builds a system prompt, and never binds tools;
 * only the frontmatter is required to decide whether a trigger applies. The
 * markdown body is re-read at hydration time by `prompt()`.
 */
export type DormantAgent = {
  name: string
  file: string
  description?: string
  agent: string
  triggers: string[]
  targets: string[]
}

export const DIRECTORY = "agents"
export const DEFAULT_AGENT = "explore"

export async function scan(root: string): Promise<DormantAgent[]> {
  const base = path.join(root, ".omnia")
  const files = await Glob.scan("agents/**/*.md", {
    cwd: base,
    absolute: true,
    dot: true,
    symlink: true,
  }).catch(() => [])
  const found = await Promise.all(files.map(read))
  const unique = new Map<string, DormantAgent>()
  for (const item of found) {
    if (!item || unique.has(item.name)) continue
    unique.set(item.name, item)
  }
  return [...unique.values()].toSorted((a, b) => a.name.localeCompare(b.name))
}

async function read(file: string): Promise<DormantAgent | undefined> {
  const md = await ConfigMarkdown.parse(file).catch(() => undefined)
  if (!md) return undefined
  const data = md.data as Record<string, unknown>
  // Dormancy is explicit. A normal agent file in this directory is left alone
  // so a project can keep notes next to its dormant definitions.
  if (data.dormant !== true) return undefined
  const name = string(data.name) ?? path.basename(file, path.extname(file))
  if (name.length === 0) return undefined
  return {
    name,
    file,
    description: string(data.description),
    agent: string(data.agent) ?? DEFAULT_AGENT,
    triggers: nonEmpty([...strings(data.triggers), ...strings(data.trigger)]),
    targets: nonEmpty([...strings(data.targets), ...strings(data.target)]),
  }
}

export async function prompt(agent: DormantAgent) {
  const md = await ConfigMarkdown.parse(agent.file).catch(() => undefined)
  return md?.content.trim() ?? ""
}

export function matches(agent: DormantAgent, input: { kind: string; command?: string }) {
  const triggers = agent.triggers.length > 0 ? agent.triggers : ["test-failure"]
  return triggers.some((trigger) => {
    if (trigger === "any") return true
    if (trigger === input.kind) return true
    if (!trigger.startsWith("pattern:")) return false
    const source = trigger.slice("pattern:".length).trim()
    if (source.length === 0 || input.command === undefined) return false
    return test(source, input.command)
  })
}

function test(source: string, value: string) {
  try {
    return new RegExp(source, "i").test(value)
  } catch {
    return false
  }
}

function strings(value: unknown) {
  if (typeof value === "string") return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function string(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function nonEmpty(value: string[]) {
  return [...new Set(value.map((item) => item.trim()).filter((item) => item.length > 0))]
}
