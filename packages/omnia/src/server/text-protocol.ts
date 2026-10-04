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

// Returns undefined for an unterminated quoted value: parseValue only strips
// quotes from a complete pair, so an unterminated one would otherwise be typed
// into the computer with the stray quote still in it.
function tokenize(line: string): string[] | undefined {
  const tokens: string[] = []
  let current = ""
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    // unescape understands \" \n and \t, so an escaped quote inside a value
    // must not close it; without this a space after an escaped quote splits
    // the argument in two.
    if (quoted && char === "\\" && index + 1 < line.length) {
      current += char + line[index + 1]
      index += 1
      continue
    }
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
  if (quoted) return undefined
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
    if (tokens === undefined) {
      errors.push({ line: index + 1, message: "Unterminated quoted value." })
      continue
    }
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
    // Numeric arguments must be finite and in bounds; Infinity, NaN, and
    // negatives would otherwise reach the drivers as-is.
    const errorCount = errors.length
    const numeric = (key: string, min: number, max: number): number | undefined => {
      const raw = args.get(key)
      if (raw === undefined) return undefined
      const value = Number(raw)
      if (!Number.isFinite(value) || value < min || value > max) {
        errors.push({
          line: index + 1,
          message: `Argument "${key}" must be a finite number between ${min} and ${max}.`,
        })
        return undefined
      }
      return value
    }
    const amount = numeric("amount", 0, 1_000_000)
    const limit = numeric("limit", 0, 1000)
    const x = numeric("x", -1_000_000, 1_000_000)
    const y = numeric("y", -1_000_000, 1_000_000)
    const offset = numeric("offset", 0, 10_000_000)
    const maxChars = numeric("maxchars", 1, 1_000_000)
    if (errors.length > errorCount) continue
    const allowUnverified = args.get("allow_unverified")?.toLowerCase() === "true"
    steps.push({
      action,
      ...(args.get("target") === undefined ? {} : { target: { kind: "element", elementId: args.get("target")! } }),
      ...(args.get("observationid") === undefined && args.get("observation_id") === undefined
        ? {}
        : { observationId: args.get("observationid") ?? args.get("observation_id")! }),
      ...(args.get("query") === undefined ? {} : { query: args.get("query")! }),
      ...(args.get("role") === undefined ? {} : { role: args.get("role")! }),
      ...(args.get("window") === undefined ? {} : { window: args.get("window")! }),
      ...(args.get("tab") === undefined ? {} : { tab: args.get("tab")! }),
      ...(args.get("dialog") === undefined ? {} : { dialog: args.get("dialog")! }),
      ...(args.get("prompttext") === undefined ? {} : { promptText: args.get("prompttext")! }),
      ...(args.get("expectedtype") === undefined ? {} : { expectedType: args.get("expectedtype")! }),
      ...(args.get("expectedmessage") === undefined ? {} : { expectedMessage: args.get("expectedmessage")! }),
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
      ...(amount === undefined ? {} : { amount }),
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
      ...(maxChars === undefined ? {} : { maxChars }),
      ...(allowUnverified ? { allowUnverified: true } : {}),
      ...(x === undefined ? {} : { x }),
      ...(y === undefined ? {} : { y }),
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
    properties[parameter] = { type: entry.parameterTypes?.[parameter] ?? "string", description: `Argument ${parameter}.` }
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
