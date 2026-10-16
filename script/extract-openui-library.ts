// Extracts the official OpenUI component library into Omnia's own
// framework-agnostic spec (packages/core/src/openui/{spec,schema,prompt}.ts).
//
// OpenUI ships first-party runtimes for React, Vue, Svelte and Angular, but not
// Solid, which is what this app is written in. `@openuidev/lang-core` is the
// framework-independent half of the project (parser, prompt generation, JSON
// Schema), so Omnia keeps the official component vocabulary and renders it with
// its own Solid components instead of re-implementing OpenUI Lang.
//
// The extractor is not part of the repo's dependencies: `@openuidev/react-ui`
// drags in React, Radix, d3 and friends, which have no business in this
// lockfile. Install them in a scratch directory instead, where the versions are
// pinned to what the lockfile's minimum release age allows:
//
//   mkdir -p /tmp/openui-extract && cd /tmp/openui-extract && npm init -y
//   npm install --legacy-peer-deps zod@4.1.8 @openuidev/lang-core@0.3.2 \
//     @openuidev/react-lang@0.4.1 @openuidev/react-ui@0.17.1 \
//     @openuidev/react-headless@0.17.0 react@19 react-dom@19 zustand
//   cd - && OPENUI_SOURCE_DIR=/tmp/openui-extract bun run script/extract-openui-library.ts
//
// Rewrites three generated files and prints what changed. The client set of
// components to keep is COMPONENTS below; the prompt is regenerated from exactly
// those, which is what keeps the model's vocabulary equal to what the renderer
// can draw (the renderer registry is checked against it at type level in
// packages/session-ui/src/openui/registry.ts).

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

type ComponentSpec = { signature: string; description?: string }
type ComponentGroup = { name: string; components: string[]; notes?: string[] }
type JSONSchema = Record<string, unknown>
type LibrarySpec = {
  root: string
  components: Record<string, ComponentSpec>
  componentGroups?: ComponentGroup[]
  schema?: JSONSchema
}
type JSONSchemaDocument = {
  $defs?: Record<string, JSONSchema>
  properties?: Record<string, unknown>
  required?: string[]
} & JSONSchema

const LANGUAGE = "0.3.2"

// Every component the Solid renderer implements. Adding one here without a
// renderer fails `bun typecheck` in packages/session-ui.
const COMPONENTS = [
  "Stack",
  "Separator",
  "Tabs",
  "TabItem",
  "Steps",
  "StepsItem",
  "Modal",
  "Card",
  "CardHeader",
  "TextContent",
  "MarkDownRenderer",
  "Callout",
  "TextCallout",
  "Image",
  "ImageBlock",
  "CodeBlock",
  "InlineHeader",
  "ListBlock",
  "ListItem",
  "TagBlock",
  "Tag",
  "Icon",
  "EntityList",
  "Text",
  "BoldText",
  "IconText",
  "MetricIndicatorInline",
  "Table",
  "Col",
  "BarChart",
  "LineChart",
  "AreaChart",
  "PieChart",
  "HorizontalBarChart",
  "SingleStackedBarChart",
  "Series",
  "Form",
  "FormControl",
  "Label",
  "Input",
  "TextArea",
  "Select",
  "SelectItem",
  "CheckBoxGroup",
  "CheckBoxItem",
  "RadioGroup",
  "RadioItem",
  "SwitchGroup",
  "SwitchItem",
  "Slider",
  "Chips",
  "ChipItem",
  "OptionCards",
  "OptionCard",
  "Buttons",
  "Button",
  "IconButton",
]

/**
 * The upstream prompt is written for a UI-generation app: its opening line says
 * the model's ENTIRE response must be openui-lang, and `inlineMode` does not
 * soften it. In chat that persona wins over the inline-mode rules further down,
 * so every answer — even "what can you do" — comes back as a card. Replace it
 * with a chat-first persona instead. Applied to the generated text so a
 * regeneration cannot reintroduce it.
 */
const UPSTREAM_PERSONA =
  "You are an AI assistant that responds using openui-lang, a declarative UI language. Your ENTIRE response must be valid openui-lang code — no markdown, no explanations, just openui-lang."

const CHAT_PERSONA =
  "You are a helpful assistant having a conversation, and you answer in plain markdown by default. Most replies need no drawing at all: a greeting, an explanation, a plan, a question you were asked, a status update, or a list of what you can do is prose and nothing else. When — and only when — a visual or interactive answer is genuinely clearer than prose (a chart, a table, a dashboard, a form) you include one fenced openui-lang block built from the language below. A drawing is never the whole reply: your words stand on their own and the block supports them. The rules below describe that language for when you do draw."

/**
 * Extra rules appended to the generated prompt. The generated prompt is written
 * for a UI-generation app where every answer is openui-lang; Omnia is a chat
 * first, so the model is told when not to reach for UI at all.
 */
const ADDITIONAL_RULES = [
  "Only render these components when a visual or interactive answer is genuinely clearer than prose. For a normal question or explanation, answer in plain markdown text with no openui-lang block at all.",
  "Never wrap prose in Card, Stack or any other container just to make an answer look designed. A component is the answer only when it carries data or accepts input — a chart, a table, a dashboard, a form — never a decorated restatement of a sentence.",
  "Never answer a question about yourself, your capabilities, this conversation, or the format of your replies with a component. Those answers are plain text.",
  "At most one fenced openui-lang block per reply, and never a second one that repeats what the first already shows.",
  "Never repeat data in prose that you have already rendered as a component, and never leave a component empty.",
  "Prefer Table for comparisons, charts for trends, Callout for warnings, and Form only when the user needs to submit structured input.",
  "When you render UI, keep it in one fenced ```openui-lang block. Text outside the block is shown as chat to the user.",
]

const root = path.join(import.meta.dir, "..")
const scratch = process.env.OPENUI_SOURCE_DIR ?? "/tmp/openui-extract"
const cdn = (name: string) => path.join(scratch, "node_modules", name, "dist", "index.mjs")

const { generateSystemPrompt } = (await import(cdn("@openuidev/lang-core"))) as {
  generateSystemPrompt: (spec: { library: LibrarySpec; promptOptions: Record<string, unknown> }) => string
}
const { openuiLibrary } = (await import(cdn("@openuidev/react-ui"))) as {
  openuiLibrary: { toSpec(): LibrarySpec; toJSONSchema(): JSONSchemaDocument }
}

const full = openuiLibrary.toSpec()
const fullSchema = openuiLibrary.toJSONSchema()
const selected = new Set(COMPONENTS)

for (const name of COMPONENTS) {
  if (!(name in full.components)) throw new Error(`${name} is not in the official library (lang-core ${LANGUAGE})`)
}

// Keep the defs the selected components reach. A union that offers an
// unselected component loses that branch rather than the whole union.
const kept = new Set<string>()
const visit = (node: unknown) => {
  if (Array.isArray(node)) {
    node.forEach(visit)
    return
  }
  if (!node || typeof node !== "object") return
  const ref = (node as { $ref?: unknown }).$ref
  if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
    const name = ref.slice("#/$defs/".length)
    if (fullSchema.$defs?.[name]) collect(name)
  }
  for (const value of Object.values(node)) visit(value)
}
const collect = (name: string) => {
  if (kept.has(name)) return
  kept.add(name)
  visit(fullSchema.$defs?.[name])
}
for (const name of COMPONENTS) collect(name)

const prune = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(prune).filter((item) => item !== undefined)
  if (!node || typeof node !== "object") return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) out[key] = prune(value)
  for (const key of ["anyOf", "oneOf"] as const) {
    const union = out[key]
    if (!Array.isArray(union)) continue
    const pending = union.filter((item) => {
      const ref = (item as { $ref?: unknown } | null)?.$ref
      if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) return true
      return kept.has(ref.slice("#/$defs/".length))
    })
    if (pending.length === 0) return undefined
    out[key] = pending
  }
  return out
}

const defs: Record<string, JSONSchema> = {}
for (const name of kept) defs[name] = prune(fullSchema.$defs?.[name]) as JSONSchema

const schema: JSONSchemaDocument = { ...fullSchema, $defs: defs }
schema.properties = Object.fromEntries(COMPONENTS.map((name) => [name, { $ref: `#/$defs/${name}` }]))
schema.required = COMPONENTS

const components = Object.fromEntries(COMPONENTS.map((name) => [name, full.components[name]!]))
const componentGroups = (full.componentGroups ?? []).map((group) => ({
  ...group,
  components: group.components.filter((name) => selected.has(name)),
}))
const library: LibrarySpec = {
  root: full.root ?? "Stack",
  components,
  componentGroups: componentGroups.filter((group) => group.components.length > 0),
  schema,
}

const prompt = generateSystemPrompt({
  library,
  promptOptions: { tools: [], examples: [], inlineMode: true, additionalRules: ADDITIONAL_RULES },
}).replace(UPSTREAM_PERSONA, CHAT_PERSONA)

if (prompt.includes(UPSTREAM_PERSONA)) throw new Error("the generated prompt still opens with the UI-generation persona")

const banner = `// GENERATED FILE — do not edit by hand.
// Source: thesysdev/openui @openuidev/react-ui openuiLibrary, pruned to the
// components the Solid renderer implements (see packages/core/src/openui/AGENTS.md).
// Regenerate with: bun run script/extract-openui-library.ts
`

const write = (file: string, contents: string) => {
  const target = path.join(root, file)
  const previous = readFileSync(target, "utf8")
  writeFileSync(target, contents)
  console.log(previous === contents ? `unchanged ${file}` : `wrote     ${file}`)
}

write(
  "packages/core/src/openui/spec.ts",
  `${banner}
export const OPENUI_ROOT = ${JSON.stringify(library.root)}

export type OpenUIComponentSpec = { signature: string; description?: string }

export type OpenUIComponentGroup = { name: string; components: string[]; notes?: string[] }

export const OPENUI_COMPONENTS: Readonly<Record<string, OpenUIComponentSpec>> = ${JSON.stringify(components, null, 2)}

export const OPENUI_COMPONENT_GROUPS: readonly OpenUIComponentGroup[] = ${JSON.stringify(library.componentGroups, null, 2)}
`,
)

write(
  "packages/core/src/openui/schema.ts",
  `${banner}
import type { OpenUILibrarySchema } from "./types"

export const OPENUI_SCHEMA: OpenUILibrarySchema = ${JSON.stringify(schema, null, 2)}
`,
)

write(
  "packages/core/src/openui/prompt.ts",
  `${banner}
export const OPENUI_SYSTEM_PROMPT = ${JSON.stringify(prompt)}
`,
)

console.log(`components ${COMPONENTS.length}, defs ${kept.size}, prompt ${prompt.length} bytes`)
