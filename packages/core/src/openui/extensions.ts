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
export const OPENUI_EXTENSION_COMPONENTS = ["JsCard", "Html", "Svg"] as const

export type OpenUIExtensionComponent = (typeof OPENUI_EXTENSION_COMPONENTS)[number]

/**
 * The positional signature of each extension component, in the order its schema
 * declares its properties — that order *is* the call order, so the two live
 * together and the prompt is written from this map rather than repeating it.
 */
export const OPENUI_EXTENSION_SIGNATURES: Record<OpenUIExtensionComponent, string> = {
  Html: "Html(title: string, code: string, height?: number)",
  Svg: "Svg(markup: string, title?: string, height?: number)",
  JsCard: "JsCard(code: string, title?: string, height?: number, width?: number)",
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
const JS_CARD_DESCRIPTION = `${OPENUI_EXTENSION_SIGNATURES.JsCard} — Renders one card whose contents are JavaScript you write, executed in a sandboxed frame and assembled as the answer streams. In scope: root (the element to draw into, already sized), theme (the app's palette by token name without the versioning prefix and without dashes, so --v2-text-text-base is theme.textTextBase and --v2-state-fg-success is theme.stateFgSuccess, plus theme.scheme for light or dark), size ({ width, height } in CSS pixels, kept current), dpr (the capped device pixel ratio), onResize(callback) (called on every resize), canvas() (appends and fits a device-pixel-ratio-correct 2D canvas, returned as { canvas, ctx, fit }), setHeight(pixels) (ask the card to grow to what you drew), and await import("https://esm.sh/...") for any library you need. The escape hatch for what no component above can express: 3D scenes, point clouds, force-directed graphs, maps, phase portraits, animated simulations, and interactive cards with their own layout, controls and tooltips.`

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

const JS_CARD: OpenUIJSONSchema = {
  type: "object",
  properties: {
    code: { type: "string" },
    title: { type: "string" },
    height: { type: "number" },
    width: { type: "number" },
  },
  required: ["code"],
  additionalProperties: false,
  id: "JsCard",
  description: JS_CARD_DESCRIPTION,
}

/** The extension's schema fragment, in the same shape the generated library uses. */
export const OPENUI_EXTENSION_SCHEMA: OpenUILibrarySchema = {
  properties: {
    Html: { $ref: refer("Html") },
    Svg: { $ref: refer("Svg") },
    JsCard: { $ref: refer("JsCard") },
  },
  $defs: { Html: HTML, Svg: SVG, JsCard: JS_CARD },
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
  JS_CARD_DESCRIPTION,
  "",
  "Rules for JsCard:",
  "- Write JavaScript, not a document: the card brings its own frame, head and sizing. Reach for Html when the answer is a whole page, and Svg when it is static vector art.",
  "- The code is one string inside the program, so escape it like one: write a newline as a backslash followed by n, a literal double quote as a backslash followed by a quote, and a literal backslash as two backslashes. Backticks and ${...} are not available there — build any dynamic markup by concatenating strings.",
  "- Rebuild rather than add to: begin with root.replaceChildren(), then draw from your data. The script runs again whenever the card is redrawn, so it must never depend on what a previous run left behind.",
  "- Size the card honestly: height is the box in pixels (default 420, allowed 160–1200) and width is a share of the answer's width (default 100, allowed 25–100). When the drawing knows its own height, call setHeight(pixels) instead of guessing.",
  "- It runs in a sandboxed frame with an opaque origin: network imports and fetch work, but the app, its storage, its cookies and its parent window are unreachable. Never try to reach the parent — setHeight is the only channel out.",
  "- Color with theme.*, never a literal: a token loses its --v2- prefix and its dashes (--v2-text-text-base is theme.textTextBase), theme.scheme is light or dark, and the frame's background is transparent.",
  "- Draw the real thing: axis labels with units, a legend when there is more than one series, a sensible aspect ratio, type no smaller than 11px, and no placeholder data left in.",
  "- The card is inert until the reader clicks into it — that is what keeps the answer scrolling while the pointer rests on the drawing — so do not make a first paint that depends on hover. A click hands the pointer to the card, and a card that draws past its box scrolls inside itself; Escape or a click outside hands the pointer back.",
  "- Keep the cost bounded: thousands of marks are fine, a million are not. Draw through canvas() for a crisp result, coalesce animation frames, and cancel timers, observers and animation loops you no longer need.",
  "- A thrown error replaces the drawing with the failure, so a card that cannot draw has failed the answer.",
  "- Prefer the built-in charts and components when they fit. Reach for JsCard when the shape of the visual is the answer — a 3D scene, a force-directed graph, a map, or a custom interactive card.",
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
  "- The frame is inert until the reader clicks into it, so the answer keeps scrolling while the pointer rests on the document; a click hands it the pointer, and Escape or a click outside hands it back. Do not make a first paint that depends on hover.",
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
