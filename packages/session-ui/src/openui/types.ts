import type { JSX } from "solid-js"
import type { OpenUIElement } from "@opencode-ai/core/openui"

/**
 * A rendered OpenUI Lang component.
 *
 * `props` is whatever the parser resolved for the component's positional
 * signature. `renderNode` renders a child value (a nested element, an array of
 * elements, or a plain value) with the same rules the top level uses, so a
 * renderer never resolves children itself.
 */
export type OpenUIComponentRenderer = (input: {
  props: Record<string, unknown>
  renderNode: (value: unknown) => JSX.Element
  /**
   * Sends a generated button's message back to the conversation. Absent when the
   * surface is read-only (a shared transcript, a preview), in which case a button
   * renders but cannot do anything.
   */
  onAction?: (message: string) => void
}) => JSX.Element

/** One module's contribution to the renderer registry, keyed by component name. */
export type OpenUIRendererMap = Record<string, OpenUIComponentRenderer>

export type { OpenUIElement }
