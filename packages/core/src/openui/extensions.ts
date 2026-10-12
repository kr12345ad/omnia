import type { OpenUILibrarySchema, OpenUIJSONSchema } from "./types"

/**
 * The components this build adds on top of the generated OpenUI library.
 *
 * `spec.ts`, `schema.ts` and `prompt.ts` are generated from upstream
 * `@openuidev/react-ui` (see AGENTS.md), so they can only ever describe a
 * component upstream ships. A component that exists because this product wants
 * it — free-reign graphics the model draws itself — is not one of those, so the
 * extra vocabulary is hand-written here and merged wherever the generated
 * library is consumed:
 *
 * - the client merges {@link mergeOpenUISchema} into the parser schema, so a
 *   program using these components validates instead of falling back to text;
 * - the client registers their renderers in
 *   `packages/session-ui/src/openui/registry.ts`;
 * - the server appends {@link OPENUI_EXTENSION_PROMPT}, so the model is told the
 *   same thing the client can draw.
 *
 * The three stay in one file on purpose: the failure this format is built to
 * avoid is the prompt advertising something the client cannot render.
 */
export const OPENUI_EXTENSION_COMPONENTS = ["Html", "Svg"] as const

export type OpenUIExtensionComponent = (typeof OPENUI_EXTENSION_COMPONENTS)[number]

/**
 * The positional signature of each extension component, in the order its schema
 * declares its properties — that order *is* the call order, so the two live
 * together and the prompt is written from this map rather than repeating it.
 */
export const OPENUI_EXTENSION_SIGNATURES: Record<OpenUIExtensionComponent, string> = {
  Html: "Html(title: string, code: string, height?: number)",
  Svg: "Svg(markup: string, title?: string, height?: number)",
}

/**
 * One line per component: the signature the model writes plus what it draws.
 * The schema's `description` and the prompt line are the same string, so the
 * parser's own errors and the system prompt cannot drift apart.
 */
const HTML_DESCRIPTION =
  `${OPENUI_EXTENSION_SIGNATURES.Html} — Renders one complete HTML document you write, in a sandboxed frame with scripts enabled. code is the entire document: <!doctype html>, its own <style> and <script>, and a closing </html>.`
const SVG_DESCRIPTION =
  `${OPENUI_EXTENSION_SIGNATURES.Svg} — Inline SVG markup drawn in the answer itself, for static vector art — a schematic, a diagram, a custom 2D plot. Scripts, foreignObject and external references are stripped, so it stays a drawing.`

const refer = (name: string) => `#/$defs/${name}`

const HTML: OpenUIJSONSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    code: { type: "string" },
    height: { type: "number" },
  },
  required: ["title", "code"],
  additionalProperties: false,
  id: "Html",
  description: HTML_DESCRIPTION,
}

const SVG: OpenUIJSONSchema = {
  type: "object",
  properties: {
    markup: { type: "string" },
    title: { type: "string" },
    height: { type: "number" },
  },
  required: ["markup"],
  additionalProperties: false,
  id: "Svg",
  description: SVG_DESCRIPTION,
}

/** The extension's schema fragment, in the same shape the generated library uses. */
export const OPENUI_EXTENSION_SCHEMA: OpenUILibrarySchema = {
  properties: { Html: { $ref: refer("Html") }, Svg: { $ref: refer("Svg") } },
  $defs: { Html: HTML, Svg: SVG },
}

/**
 * The prompt section that documents the extension components.
 *
 * It is appended to `OPENUI_SYSTEM_PROMPT` by the server
 * (`packages/opencode/src/session/system.ts`). Like the generated prompt it
 * keeps to signatures plus the rules a model cannot guess: what the frame
 * allows, which tokens it is seeded with, and when drawing by hand beats the
 * built-in components.
 */
export const OPENUI_EXTENSION_PROMPT = [
  "### Generated graphics",
  "",
  "The charts above cover standard 2D business charts. Everything below is for the graphics those cannot express — a 3D surface or point cloud, a phase portrait, a network or Sankey diagram, a map, an animated simulation, or an interactive plot with zoom, brushing and tooltips. Draw it instead of simplifying the answer:",
  "",
  HTML_DESCRIPTION,
  SVG_DESCRIPTION,
  "",
  "Rules for Html:",
  "- Write the whole document, and close every tag. Nothing is injected into it except the theme bridge below.",
  "- The frame has an opaque origin: it can load scripts and data from the network (a CDN <script src=\"https://...\"> is allowed, and so is fetch), but it cannot read the app, its storage, its cookies or its parent window. Never try to reach the parent.",
  "- The document gets the app's theme tokens as CSS custom properties: --v2-background-bg-base, --v2-background-bg-deep, --v2-background-bg-layer-01, --v2-background-bg-layer-02, --v2-text-text-base, --v2-text-text-muted, --v2-text-text-faint, --v2-text-text-accent, --v2-border-border-muted, --v2-border-border-base, --v2-icon-icon-muted, --v2-icon-icon-accent, --v2-state-fg-success, --v2-state-fg-warning, --v2-state-fg-danger, --v2-state-fg-info, plus color-scheme. Style with var(--v2-...) instead of literal colors so the graphic follows the app's light and dark themes.",
  "- The frame's width follows the answer; its height is height (default 420). Set body margin: 0, make sure the drawing fits that box, and leave the background transparent (or use a layer token) so it sits on the answer.",
  "- Aim for a real graphic, not a demo: axis labels with units, a legend when there is more than one series, a sensible aspect ratio, type no smaller than 11px, and no placeholder data left in.",
  "- Keep the drawing cost bounded: thousands of marks are fine, a million are not. Prefer instancing or a coarse mesh for 3D, and cap the device pixel ratio at 2.",
  "- Never ship a black-on-transparent plot: read the seeded tokens or the color-scheme variable so the drawing is readable in both themes.",
  "- Prefer the built-in charts above when they fit. Reach for Html when the shape of the visual is the answer.",
].join("\n")

/** A component-list position in the generated schema: `{ anyOf: [{ $ref: … }, …] }`. */
function isComponentRef(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const ref = (value as { $ref?: unknown }).$ref
  return typeof ref === "string" && ref.startsWith("#/$defs/")
}

/**
 * Re-opens every generated component list to the extension components.
 *
 * `Card(children)` and `TabItem(content)` name the components they accept, and
 * upstream has never heard of `Html`, so the generated union would reject it.
 * Every one of those positions is an `anyOf` whose entries are all component
 * refs; extending exactly those leaves every other constraint untouched.
 */
function openComponentLists(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(openComponentLists)
  if (typeof node !== "object" || node === null) return node
  const record = node as Record<string, unknown>
  const entries = Array.isArray(record.anyOf) ? record.anyOf : undefined
  const extended =
    entries && entries.length > 0 && entries.every(isComponentRef)
      ? [...entries, ...OPENUI_EXTENSION_COMPONENTS.map((name) => ({ $ref: refer(name) }))]
      : entries
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, key === "anyOf" && extended ? extended : openComponentLists(value)]),
  )
}

/** The generated library plus this build's own components. */
export function mergeOpenUISchema(base: OpenUILibrarySchema): OpenUILibrarySchema {
  return {
    ...base,
    properties: { ...(base.properties ?? {}), ...(OPENUI_EXTENSION_SCHEMA.properties ?? {}) },
    $defs: {
      ...(openComponentLists(base.$defs ?? {}) as Record<string, OpenUIJSONSchema>),
      ...(OPENUI_EXTENSION_SCHEMA.$defs ?? {}),
    },
  }
}
