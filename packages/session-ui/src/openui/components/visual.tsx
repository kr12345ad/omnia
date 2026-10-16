import DOMPurify from "dompurify"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Spinner } from "@opencode-ai/ui/spinner"
import { text } from "../helpers"
import { TEXT_MUTED } from "../theme"
import type { OpenUIComponentRenderer, OpenUIRendererMap } from "../types"
import { DEFAULT_HEIGHT, Embedded, Frame, heightProp, SETTLE_MS, themedDocument } from "./frame"

/**
 * The graphics the model draws itself: `Html` and `Svg`.
 *
 * These are the extension components declared in
 * `packages/core/src/openui/extensions.ts` — the answer's escape hatch from the
 * built-in vocabulary, for a 3D surface, a bespoke interactive plot or a diagram
 * no component in the library covers. They render outside the component system
 * rather than through it: an `Html` document is a complete page in a sandboxed
 * frame, an `Svg` is vector markup of the model's own making, and `JsCard`
 * (`js-card.tsx`) is JavaScript that draws into its own frame.
 *
 * `Html` cannot inherit the app's styles, so the frame is seeded with the v2
 * theme tokens as CSS custom properties before the document runs. That is what
 * keeps a hand-drawn graphic themed instead of a dark box on a light answer.
 *
 * Both documents go through `Embedded` (`frame.tsx`), so both keep the answer
 * scrollable until the reader clicks into the drawing.
 */

const DEFAULT_SVG_HEIGHT = 240

function cleanSvg(markup: string) {
  if (!markup.trim()) return ""
  if (typeof window === "undefined" || !DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(markup, { USE_PROFILES: { svg: true, svgFilters: true } })
}

const Html: OpenUIComponentRenderer = ({ props }) => {
  const code = () => text(props.code) ?? ""
  const [settled, setSettled] = createSignal<string>()
  const height = heightProp(props.height, DEFAULT_HEIGHT)

  // Streaming rewrites the document on every delta and an iframe re-mounts on
  // each one, so wait for the text to stop changing and mount the finished page
  // once instead of a dozen partial ones.
  createEffect(() => {
    const next = code()
    const timer = setTimeout(() => setSettled(next), SETTLE_MS)
    onCleanup(() => clearTimeout(timer))
  })

  return (
    <Frame name="openui-html" title={text(props.title)} height={height}>
      <Show
        when={settled()}
        fallback={
          <div
            data-slot="openui-html-loading"
            class="flex items-center justify-center"
            style={{ height: `${height}px` }}
          >
            <Spinner class="size-4" />
          </div>
        }
      >
        {(document) => (
          <Embedded name="openui-html" title={text(props.title)} height={height} srcDoc={themedDocument(document())} />
        )}
      </Show>
    </Frame>
  )
}

const Svg: OpenUIComponentRenderer = ({ props }) => {
  const markup = () => cleanSvg(text(props.markup) ?? "")
  const height = heightProp(props.height, DEFAULT_SVG_HEIGHT)

  return (
    <Frame name="openui-svg" title={text(props.title)} height={height}>
      <div
        data-slot="openui-svg-drawing"
        class={`flex w-full items-center justify-center overflow-hidden p-3 ${TEXT_MUTED}`}
        style={{ height: `${height}px` }}
        innerHTML={markup()}
      />
    </Frame>
  )
}

export const visualRenderers: OpenUIRendererMap = { Html, Svg }
