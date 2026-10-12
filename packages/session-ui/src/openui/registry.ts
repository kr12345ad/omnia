import { OPENUI_COMPONENTS, OPENUI_ROOT } from "@opencode-ai/core/openui"
import { actionRenderers } from "./components/actions"
import { contentRenderers } from "./components/content"
import { dataRenderers } from "./components/data"
import { formRenderers } from "./components/forms"
import { layoutRenderers } from "./components/layout"
import { visualRenderers } from "./components/visual"
import type { OpenUIComponentRenderer, OpenUIRendererMap } from "./types"

type ComponentName = keyof typeof OPENUI_COMPONENTS

/**
 * Every OpenUI Lang component the prompt advertises must render here.
 *
 * The prompt is generated from the same component list, and each module declares
 * its own component names, so this `satisfies` is the contract: adding a
 * component to the library (or renaming one) without a renderer is a type error,
 * not a blank box in a conversation.
 */
export const openuiRenderers = {
  ...layoutRenderers,
  ...contentRenderers,
  ...dataRenderers,
  ...formRenderers,
  ...actionRenderers,
} satisfies Record<ComponentName, OpenUIComponentRenderer>

/**
 * Renderers for the components this build adds on top of the generated library
 * (`packages/core/src/openui/extensions.ts`).
 *
 * Kept out of the `satisfies` map above on purpose: that contract is about the
 * generated library, and these names are deliberately not part of it.
 */
export const openuiExtensionRenderers: OpenUIRendererMap = { ...visualRenderers }

export { OPENUI_ROOT }
