import type { ServerBatchStep, StepExpectation } from "./computers"
import { OMNIA_ACTION_CATALOG, type ActionCatalogEntry } from "./catalog"

export interface ParsedScript {
  readonly steps: readonly ServerBatchStep[]
  readonly errors: readonly { readonly line: number; readonly message: string }[]
}

const QUOTED = /^"((?:[^"\\]|\\.)*)"$/

const KNOWN_ACTIONS = new Set(OMNIA_ACTION_CATALOG.map((entry) => entry.action))

function unescape(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\t/g, "\t")
}

function parseValue(raw: string): string {
  const quoted = raw.match(QUOTED)
  if (quoted?.[1] !== undefined) return unescape(quoted[1])
  return raw
}

function tokenize(line: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quoted = false
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted
      current += char
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

// The text protocol exists so a model that cannot emit tool calls can still
// operate the computer: one action per line, `key=value` arguments, optional
// double-quoted values. The whole script is validated before anything runs.
export function parseActionScript(script: string): ParsedScript {
  const steps: ServerBatchStep[] = []
  const errors: { line: number; message: string }[] = []
  const lines = script.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!.trim()
    if (raw.length === 0 || raw.startsWith("#")) continue
    const tokens = tokenize(raw)
    const action = tokens.shift()
    if (action === undefined) continue
    if (!KNOWN_ACTIONS.has(action)) {
      errors.push({ line: index + 1, message: `Unknown action "${action}".` })
      continue
    }
    const args = new Map<string, string>()
    for (const token of tokens) {
      const separator = token.indexOf("=")
      if (separator <= 0) {
        errors.push({ line: index + 1, message: `Argument "${token}" must be key=value.` })
        continue
      }
      args.set(token.slice(0, separator).toLowerCase(), parseValue(token.slice(separator + 1)))
    }
    const expect: StepExpectation = {
      ...(args.get("expect_text") === undefined ? {} : { text: args.get("expect_text")! }),
      ...(args.get("expect_window") === undefined ? {} : { window: args.get("expect_window")! }),
      ...(args.get("expect_file") === undefined ? {} : { file: args.get("expect_file")! }),
    }
    const keys = args.get("keys")
    const amount = args.get("amount")
    steps.push({
      action,
      ...(args.get("target") === undefined ? {} : { target: { kind: "element", elementId: args.get("target")! } }),
      ...(args.get("query") === undefined ? {} : { query: args.get("query")! }),
      ...(args.get("role") === undefined ? {} : { role: args.get("role")! }),
      ...(args.get("window") === undefined ? {} : { window: args.get("window")! }),
      ...(args.get("tab") === undefined ? {} : { tab: args.get("tab")! }),
      ...(args.get("text") === undefined ? {} : { text: args.get("text")! }),
      ...(args.get("start") === undefined ? {} : { start: args.get("start")! }),
      ...(args.get("stop") === undefined ? {} : { stop: args.get("stop")! }),
      ...(args.get("endkey") === undefined ? {} : { endKey: args.get("endkey")! }),
      ...(args.get("key") === undefined ? {} : { key: args.get("key")! }),
      ...(keys === undefined ? {} : { keys: keys.split(/[+,]/).map((key) => key.trim()).filter((key) => key.length > 0) }),
      ...(args.get("app") === undefined ? {} : { app: args.get("app")! }),
      ...(args.get("url") === undefined ? {} : { url: args.get("url")! }),
      ...(args.get("path") === undefined ? {} : { path: args.get("path")! }),
      ...(args.get("direction") === undefined ? {} : { direction: args.get("direction")! }),
      ...(args.get("button") === undefined ? {} : { button: args.get("button")! }),
      ...(amount === undefined || Number.isNaN(Number(amount)) ? {} : { amount: Number(amount) }),
      ...(args.get("limit") === undefined || Number.isNaN(Number(args.get("limit"))) ? {} : { limit: Number(args.get("limit")!) }),
      ...(args.get("x") === undefined || Number.isNaN(Number(args.get("x"))) ? {} : { x: Number(args.get("x")!) }),
      ...(args.get("y") === undefined || Number.isNaN(Number(args.get("y"))) ? {} : { y: Number(args.get("y")!) }),
      ...(Object.keys(expect).length === 0 ? {} : { expect }),
    })
  }
  return { steps, errors }
}

export function renderCatalogText(entries: readonly ActionCatalogEntry[] = OMNIA_ACTION_CATALOG): string {
  const lines = [
    "OMNIA COMPUTER ACTIONS",
    "Each action accepts the listed arguments as key=value pairs.",
    "",
  ]
  for (const entry of entries) {
    lines.push(`${entry.action}${entry.parameters.length === 0 ? "" : ` ${entry.parameters.map((parameter) => `${parameter}=<value>`).join(" ")}`}`)
    lines.push(`  ${entry.description}`)
  }
  lines.push(
    "",
    "TEXT PROTOCOL",
    "A model that cannot call tools can still operate the computer by emitting",
    "one action per line inside a fenced omnia block. The whole script is",
    "validated before anything runs, so a malformed line executes nothing.",
    "",
    "```omnia",
    'launch_app app="soffice --writer" expect_window="LibreOffice Writer"',
    'type query="document text" text="Quarterly report" endKey=Return',
    'browser_open url="https://example.com"',
    'browser_find query="Search" role="textbox"',
    'browser_type target="omnia-1" text="suppliers"',
    'browser_key key="Enter"',
    'read_text query="document text"',
    "```",
  )
  return lines.join("\n")
}

export interface ToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

function toolParameters(entry: ActionCatalogEntry): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    action: { type: "string", const: entry.action, description: "The action to perform." },
  }
  for (const parameter of entry.parameters) {
    properties[parameter] = { type: "string", description: `Argument ${parameter}.` }
  }
  return { type: "object", properties, required: ["action"], additionalProperties: false }
}

export function renderToolSchemas(entries: readonly ActionCatalogEntry[] = OMNIA_ACTION_CATALOG): ToolSchema[] {
  return entries.map((entry) => ({
    name: `omnia_${entry.action}`,
    description: `${entry.description} Required permissions: ${entry.requires.join(", ") || "none"}.`,
    parameters: toolParameters(entry),
  }))
}

export function renderOpenAiTools(entries: readonly ActionCatalogEntry[] = OMNIA_ACTION_CATALOG): unknown[] {
  return renderToolSchemas(entries).map((schema) => ({
    type: "function",
    function: { name: schema.name, description: schema.description, parameters: schema.parameters },
  }))
}

export function renderAnthropicTools(entries: readonly ActionCatalogEntry[] = OMNIA_ACTION_CATALOG): unknown[] {
  return renderToolSchemas(entries).map((schema) => ({
    name: schema.name,
    description: schema.description,
    input_schema: schema.parameters,
  }))
}
