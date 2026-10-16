import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { canScrollFrame, frameScrollChannel, readFrameScrollBox, wheelScrollDelta, type FrameScrollBox } from "../frame-scroll"
import { num } from "../helpers"
import { PANEL, TEXT } from "../theme"

/**
 * The shared parts of a surface whose content is drawn outside the component
 * system: the frame it sits in, the theme bridge that dresses it, and the gate
 * that keeps the answer scrollable around it.
 *
 * `Html`, `Svg` and `JsCard` are the extension components declared in
 * `packages/core/src/openui/extensions.ts`. `Html` and `JsCard` each run their
 * content in an iframe with an opaque origin, which cannot inherit the app's
 * styles, so both are seeded with the v2 tokens as CSS custom properties before
 * they run — that is what keeps a hand-drawn graphic themed instead of a dark
 * box on a light answer. The SVG drawing is inline and needs no frame, but it
 * shares the figure and the title bar so every drawn answer is one shape.
 */

/** A streamed document or script is mounted once the model stops writing for this long. */
export const SETTLE_MS = 500

export const DEFAULT_HEIGHT = 420
export const MIN_HEIGHT = 160
export const MAX_HEIGHT = 1200

/** The tokens a generated document or script may rely on; every one is seeded into the frame. */
export const THEME_TOKENS = [
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
] as const

export function heightProp(value: unknown, fallback = DEFAULT_HEIGHT) {
  const height = num(value)
  if (height === undefined) return fallback
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(height)))
}

/**
 * The app's palette, read once per drawn surface: the tokens it declares and the
 * color scheme they belong to. Read from the app document, because a frame with
 * an opaque origin cannot see the app's styles through the cascade.
 */
function palette() {
  if (typeof document === "undefined") return { tokens: [] as [string, string][], scheme: "light" }
  const computed = getComputedStyle(document.documentElement)
  return {
    tokens: THEME_TOKENS.flatMap((token) => {
      const value = computed.getPropertyValue(token).trim()
      return value ? [[token, value] as [string, string]] : []
    }),
    scheme: computed.getPropertyValue("color-scheme").trim() || "light",
  }
}

/** The theme bridge: the app's token values plus the baseline rules a drawing starts from. */
export function themeBridge() {
  const { tokens, scheme } = palette()
  const declarations = tokens.map(([token, value]) => `${token}:${value}`)
  declarations.push(`color-scheme:${scheme}`)

  return [
    `<style data-openui-theme>:root{${declarations.join(";")}}`,
    "html,body{margin:0;padding:0;background:transparent;color:var(--v2-text-text-base);",
    'font-family:system-ui,-apple-system,"Segoe UI",sans-serif}</style>',
  ].join("")
}

/**
 * The same palette as the object a card's script reads: `--v2-text-text-base` is
 * `theme.textTextBase`. The `v2-` prefix versions the palette rather than naming
 * anything, so it is not part of the name; `scheme` comes along as `light` or
 * `dark` for a card that has to pick a color the tokens do not cover.
 */
export function themeObject() {
  const { tokens, scheme } = palette()
  return Object.fromEntries([
    ...tokens.map(([token, value]) => [
      token
        .replace(/^--/, "")
        .replace(/^v2-/, "")
        .replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase()),
      value,
    ]),
    ["scheme", scheme],
  ])
}

/** Insert the bridge at the top of the document's head, or in front of a fragment. */
export function themedDocument(code: string) {
  const head = /<head[^>]*>/i.exec(code)
  if (!head) return `${themeBridge()}${code}`
  const end = head.index + head[0].length
  return `${code.slice(0, end)}${themeBridge()}${code.slice(end)}`
}

/**
 * The figure every drawn answer lives in: the app's panel surface, an optional
 * title bar, and the box the drawing fills. `name` is the component this frame
 * belongs to (`openui-html`, `openui-js-card`, …) and names its slots with it,
 * so a surface is addressable by the component that drew it.
 *
 * A width is a share of the answer, which is why it is a percentage rather than
 * a pixel count: the answer column is not a fixed width.
 */
export function Frame(props: {
  name: string
  title?: string
  height: number
  width?: string
  children: JSX.Element
}) {
  return (
    <figure
      data-component={props.name}
      class={`my-2 flex min-w-0 flex-col overflow-hidden ${PANEL} ${props.width ? "" : "w-full"}`}
      style={props.width ? { width: props.width } : undefined}
    >
      <Show when={props.title}>
        {(title) => (
          <figcaption
            data-slot={`${props.name}-title`}
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

/**
 * The frame's body: the embedded document, and the reader's pointer.
 *
 * An embedded document owns every gesture over its box, and a wheel event inside
 * a frame never chains to the page around it. So a card used to freeze the
 * answer: with the pointer merely resting on the drawing, the transcript stopped
 * scrolling in both directions, and scrolling past a tall card was impossible.
 *
 * The frame therefore starts inert — `pointer-events: none` on the document, so
 * the wheel, the cursor and the clicks fall through to the answer — and the
 * reader's first click hands the pointer to the card. Escape, or a click
 * anywhere outside it, hands it back. That is the whole contract: the answer
 * scrolls until the card is deliberately entered, and then the pointer belongs
 * to the card (which scrolls its own content, see the frame documents' styles).
 *
 * Inert is not the same as unreachable, though. A card that overflows its box
 * was a scrollbar the reader could see and not use: a wheel over it scrolled the
 * answer, because the frame the wheel belonged to never saw it. So a frame that
 * reports its scroll box (`frame-scroll.ts`) has one of its own: the gate takes
 * the wheel whenever the frame still has somewhere to go, and the frame hands a
 * gesture back to the answer once its box ends.
 */
export function Embedded(props: {
  name: string
  title?: string
  height: number
  srcDoc: string
  /** The mounted document, for a renderer that has to talk to it (see `JsCard`). */
  frame?: (element: HTMLIFrameElement) => void
}) {
  const [active, setActive] = createSignal(false)
  const [host, setHost] = createSignal<HTMLDivElement>()
  const [mounted, setMounted] = createSignal<HTMLIFrameElement>()
  const [box, setBox] = createSignal<FrameScrollBox>()

  const scrollViewport = () => host()?.closest<HTMLElement>("[data-scrollable]") ?? undefined

  // Both directions of the scroll protocol, honored only from this frame's own
  // document — the rule the height and failure channels already follow. A frame
  // that reports nothing keeps the old behavior: the answer owns every wheel.
  createEffect(() => {
    const element = mounted()
    if (!element) return
    const listen = (event: MessageEvent) => {
      if (event.source !== element.contentWindow) return
      const data = event.data as { type?: unknown; delta?: unknown } | undefined
      if (!data || typeof data.type !== "string") return
      if (data.type === frameScrollChannel(props.name, "state")) {
        const reported = readFrameScrollBox(data)
        if (reported) setBox(reported)
        return
      }
      if (data.type !== frameScrollChannel(props.name, "overflow")) return
      const delta = num(data.delta)
      if (delta === undefined || !delta) return
      // The frame ran out of its own box mid-gesture, so its gesture continues
      // in whichever box the frame is embedded in.
      scrollViewport()?.scrollBy({ top: delta })
    }
    window.addEventListener("message", listen)
    onCleanup(() => window.removeEventListener("message", listen))
  })

  const handleWheel = (event: WheelEvent & { currentTarget: HTMLDivElement }) => {
    const scroll = box()
    if (!scroll) return
    const delta = wheelScrollDelta(event, event.currentTarget.clientHeight)
    if (!canScrollFrame(scroll, delta)) return
    // The gesture is the frame's until its box ends, so the browser is stopped
    // from scrolling the answer underneath it.
    event.preventDefault()
    mounted()?.contentWindow?.postMessage({ type: frameScrollChannel(props.name, "scroll"), delta }, "*")
  }

  createEffect(() => {
    if (!active()) return
    const outside = (event: Event) => {
      const element = host()
      if (element && event.target instanceof Node && element.contains(event.target)) return
      setActive(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActive(false)
    }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("keydown", escape)
    onCleanup(() => {
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("keydown", escape)
    })
  })

  return (
    <div
      ref={setHost}
      data-slot={`${props.name}-pointer-gate`}
      class="relative"
      classList={{ "cursor-pointer": !active(), "ring-1 ring-v2-border-border-base": active() }}
      onClick={() => setActive(true)}
      onWheel={handleWheel}
    >
      <iframe
        data-slot={`${props.name}-frame`}
        ref={(element) => {
          setMounted(element)
          props.frame?.(element)
        }}
        title={props.title}
        sandbox="allow-scripts"
        srcdoc={props.srcDoc}
        style={{ height: `${props.height}px` }}
        class="w-full border-0 bg-transparent"
        classList={{ "pointer-events-none": !active() }}
      />
    </div>
  )
}
