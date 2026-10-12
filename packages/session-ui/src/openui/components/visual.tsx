import DOMPurify from "dompurify"
import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { Spinner } from "@opencode-ai/ui/spinner"
import { num, text } from "../helpers"
import { PANEL, TEXT, TEXT_MUTED } from "../theme"
import type { OpenUIComponentRenderer, OpenUIRendererMap } from "../types"

/**
 * The graphics the model draws itself: `Html` and `Svg`.
 *
 * These are the extension components declared in
 * `packages/core/src/openui/extensions.ts` — the answer's escape hatch from the
 * built-in vocabulary, for a 3D surface, a bespoke interactive plot or a diagram
 * no component in the library covers. They render outside the component system
 * rather than through it: an `Html` document is a complete page in a sandboxed
 * frame, and an `Svg` is vector markup of the model's own making.
 *
 * `Html` cannot inherit the app's styles, so the frame is seeded with the v2
 * theme tokens as CSS custom properties before the document runs. That is what
 * keeps a hand-drawn graphic themed instead of a dark box on a light answer.
 */

const DEFAULT_FRAME_HEIGHT = 420
const DEFAULT_SVG_HEIGHT = 240
const MIN_HEIGHT = 160
const MAX_HEIGHT = 1200
/** A streamed document is mounted once the model stops writing for this long. */
const SETTLE_MS = 500

/** The tokens a generated document may rely on; every one is seeded into the frame. */
const THEME_TOKENS = [
  "--v2-background-bg-base",
  "--v2-background-bg-deep",
  "--v2-background-bg-layer-01",
  "--v2-background-bg-layer-02",
  "--v2-text-text-base",
  "--v2-text-text-muted",
  "--v2-text-text-faint",
  "--v2-text-text-accent",
  "--v2-border-border-muted",
  "--v2-border-border-base",
  "--v2-icon-icon-muted",
  "--v2-icon-icon-accent",
  "--v2-state-fg-success",
  "--v2-state-fg-warning",
  "--v2-state-fg-danger",
  "--v2-state-fg-info",
]

function heightProp(value: unknown, fallback: number) {
  const height = num(value)
  if (height === undefined) return fallback
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(height)))
}

/** The theme bridge: the app's token values plus the baseline rules a drawing starts from. */
function themeBridge() {
  const declarations =
    typeof document === "undefined"
      ? ["color-scheme:light"]
      : (() => {
          const computed = getComputedStyle(document.documentElement)
          const tokens = THEME_TOKENS.flatMap((token) => {
            const value = computed.getPropertyValue(token).trim()
            return value ? [`${token}:${value}`] : []
          })
          const scheme = computed.getPropertyValue("color-scheme").trim()
          return scheme ? [...tokens, `color-scheme:${scheme}`] : tokens
        })()

  return [
    `<style data-openui-theme>:root{${declarations.join(";")}}`,
    "html,body{margin:0;padding:0;background:transparent;color:var(--v2-text-text-base);",
    'font-family:system-ui,-apple-system,"Segoe UI",sans-serif}</style>',
  ].join("")
}

/** Insert the bridge at the top of the document's head, or in front of a fragment. */
function themedDocument(code: string) {
  const head = /<head[^>]*>/i.exec(code)
  if (!head) return `${themeBridge()}${code}`
  const end = head.index + head[0].length
  return `${code.slice(0, end)}${themeBridge()}${code.slice(end)}`
}

function cleanSvg(markup: string) {
  if (!markup.trim()) return ""
  if (typeof window === "undefined" || !DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(markup, { USE_PROFILES: { svg: true, svgFilters: true } })
}

function Frame(props: { title?: string; height: number; children: JSX.Element }) {
  return (
    <figure data-component="openui-html" class={`my-2 flex w-full min-w-0 flex-col overflow-hidden ${PANEL}`}>
      <Show when={props.title}>
        {(title) => (
          <figcaption
            data-slot="openui-html-title"
            class={`flex h-8 shrink-0 items-center border-b border-v2-border-border-muted px-3 text-12-medium ${TEXT}`}
          >
            <span class="min-w-0 truncate">{title()}</span>
          </figcaption>
        )}
      </Show>
      {props.children}
    </figure>
  )
}

const Html: OpenUIComponentRenderer = ({ props }) => {
  const code = () => text(props.code) ?? ""
  const [settled, setSettled] = createSignal<string>()
  const height = heightProp(props.height, DEFAULT_FRAME_HEIGHT)

  // Streaming rewrites the document on every delta and an iframe re-mounts on
  // each one, so wait for the text to stop changing and mount the finished page
  // once instead of a dozen partial ones.
  createEffect(() => {
    const next = code()
    const timer = setTimeout(() => setSettled(next), SETTLE_MS)
    onCleanup(() => clearTimeout(timer))
  })

  return (
    <Frame title={text(props.title)} height={height}>
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
          <iframe
            data-slot="openui-html-frame"
            title={text(props.title)}
            sandbox="allow-scripts"
            srcdoc={themedDocument(document())}
            style={{ height: `${height}px` }}
            class="w-full border-0 bg-transparent"
          />
        )}
      </Show>
    </Frame>
  )
}

const Svg: OpenUIComponentRenderer = ({ props }) => {
  const markup = () => cleanSvg(text(props.markup) ?? "")
  const height = heightProp(props.height, DEFAULT_SVG_HEIGHT)

  return (
    <Frame title={text(props.title)} height={height}>
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
