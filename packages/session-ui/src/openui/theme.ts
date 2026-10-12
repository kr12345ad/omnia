/**
 * The design foundation generated UI is drawn from.
 *
 * ChatGPT's Intelligent UI answers with a library of native components, so each
 * response "keeps a familiar design foundation": the model composes an
 * interface, it never paints one (openai.com/index/gpt-6-for-everyone). Ours is
 * the app's own v2 design system — the same tokens and components the rest of
 * the product is built from — which is what makes a generated card, table or
 * form look native in every theme and follow a theme change instead of fighting
 * it.
 *
 * Every value here resolves to a v2 token, never a literal color: a literal is
 * the one thing a generated answer could not re-theme.
 *
 * The shape stays distinctly opencode's. What is borrowed from GPT's answer UI
 * is structural, not visual: pick the format that fits the question, group
 * related blocks into panels, put comparisons side by side, let a form be a real
 * form. Radii, type scale, elevation and controls are the app's own (ButtonV2,
 * TextInputV2, Tag, app radii) so a generated answer reads as this product's
 * UI, not as another product's.
 */

/** A panel: the surface under a card, chart, table or modal. */
export const PANEL = "rounded-xl border border-v2-border-border-muted bg-v2-background-bg-layer-01"

/** A panel that reads as raised off the answer, the way a card the model offers does. */
export const PANEL_ELEVATED = `${PANEL} shadow-[var(--v2-elevation-raised)]`

/** A recessed panel: a chart well, a summary bar, a read-only value. */
export const PANEL_INSET = "rounded-xl border border-v2-border-border-muted bg-v2-background-bg-layer-02"

/** A pill: the app's own shape for a chip, tag or badge. Actions stay ButtonV2. */
export const PILL = "rounded-full border border-v2-border-border-muted"

/** Text roles: base is the answer's own color, muted a description, faint a hint. */
export const TEXT = "text-v2-text-text-base"
export const TEXT_MUTED = "text-v2-text-text-muted"
export const TEXT_FAINT = "text-v2-text-text-faint"

/** The interaction vocabulary the app's own controls use, so generated controls match. */
export const HOVER = "hover:bg-v2-overlay-simple-overlay-hover"
export const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-border-border-focus"
export const DISABLED = "disabled:cursor-not-allowed disabled:opacity-50"

/**
 * Chart series colors: the theme's state palette in a fixed order.
 *
 * A chart needs its series told apart, and the state tokens are the theme's own
 * answer to that: each is a dark foreground in light mode and a light one in
 * dark, so a generated chart stays readable in both without a literal color.
 * Past the palette, series repeat with decreasing opacity rather than inventing
 * a color the theme does not have.
 */
const SERIES = [
  "var(--v2-text-text-accent)",
  "var(--v2-state-fg-success)",
  "var(--v2-state-fg-warning)",
  "var(--v2-state-fg-danger)",
  "var(--v2-state-fg-info)",
]

export function seriesColor(index: number) {
  return {
    color: SERIES[index % SERIES.length],
    opacity: index < SERIES.length ? 1 : Math.max(0.35, 1 - (index - SERIES.length) * 0.18),
  }
}
