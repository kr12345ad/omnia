import { Icon as LegacyIcon } from "@opencode-ai/ui/icon"
import { Show, type JSX } from "solid-js"
import { Markdown } from "../../components/markdown"
import { bool, decl, decls, gap, num, text } from "../helpers"
import { legacyIconName } from "../icons"
import { PANEL, PANEL_ELEVATED, PANEL_INSET, PILL, TEXT, TEXT_FAINT, TEXT_MUTED } from "../theme"
import type { OpenUIComponentRenderer, OpenUIRendererMap } from "../types"

type RenderInput = Parameters<OpenUIComponentRenderer>[0]

const CALLOUT: Record<string, string> = {
  info: "border-v2-state-border-info bg-v2-state-bg-info text-v2-state-fg-info",
  warning: "border-v2-state-border-warning bg-v2-state-bg-warning text-v2-state-fg-warning",
  success: "border-v2-state-border-success bg-v2-state-bg-success text-v2-state-fg-success",
  error: "border-v2-state-border-danger bg-v2-state-bg-danger text-v2-state-fg-danger",
  danger: "border-v2-state-border-danger bg-v2-state-bg-danger text-v2-state-fg-danger",
  neutral: `${PANEL_INSET} text-v2-icon-icon-base`,
}

const TAG: Record<string, string> = {
  info: "border-v2-state-border-info bg-v2-state-bg-info text-v2-state-fg-info",
  success: "border-v2-state-border-success bg-v2-state-bg-success text-v2-state-fg-success",
  warning: "border-v2-state-border-warning bg-v2-state-bg-warning text-v2-state-fg-warning",
  danger: "border-v2-state-border-danger bg-v2-state-bg-danger text-v2-state-fg-danger",
  neutral: "border-v2-border-border-muted bg-v2-background-bg-layer-02 text-v2-text-text-base",
}

const TEXT_SIZE: Record<string, string> = {
  "small-heavy": "text-12-medium",
  small: "text-12-regular",
  default: "text-14-regular",
  large: "text-16-regular",
  "large-heavy": "text-16-medium",
  xs: "text-11-regular",
  sm: "text-12-regular",
  md: "text-14-regular",
  lg: "text-16-regular",
}

const ALIGN: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
}

const JUSTIFY: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
  evenly: "space-evenly",
}

/** Card and Stack share the library's flex vocabulary. */
function layoutStyle(props: Record<string, unknown>): JSX.CSSProperties {
  const resolved = gap(props.gap)
  return {
    display: "flex",
    "flex-direction": text(props.direction) === "row" ? "row" : "column",
    "flex-wrap": bool(props.wrap) ? "wrap" : "nowrap",
    "align-items": (ALIGN[text(props.align) ?? ""] ?? "stretch") as JSX.CSSProperties["align-items"],
    "justify-content": (JUSTIFY[text(props.justify) ?? ""] ?? "flex-start") as JSX.CSSProperties[
      "justify-content"
    ],
    ...(resolved === undefined ? {} : { gap: resolved }),
    "min-width": "0",
  }
}

const CARD_VARIANT: Record<string, string> = {
  card: PANEL_ELEVATED,
  sunk: PANEL_INSET,
  clear: "",
}

const Card: OpenUIComponentRenderer = ({ props, renderNode }) => (
  <div
    data-component="openui-card"
    class={`p-4 text-14-regular ${TEXT} ${CARD_VARIANT[text(props.variant) ?? "card"] ?? CARD_VARIANT.card}`}
    style={layoutStyle(props)}
  >
    {renderNode(props.children)}
  </div>
)

const CardHeader: OpenUIComponentRenderer = ({ props }) => (
  <div data-component="openui-card-header" class="flex flex-col gap-1">
    <Show when={text(props.title)}>
      <div data-slot="openui-card-title" class={`text-16-medium ${TEXT}`}>
        {text(props.title)}
      </div>
    </Show>
    <Show when={text(props.subtitle)}>
      <div data-slot="openui-card-subtitle" class={`text-13-regular ${TEXT_MUTED}`}>
        {text(props.subtitle)}
      </div>
    </Show>
  </div>
)

const TextContent: OpenUIComponentRenderer = ({ props }) => (
  <p
    data-component="openui-text-content"
    class={`whitespace-pre-wrap ${TEXT_SIZE[text(props.size) ?? "default"] ?? TEXT_SIZE.default} ${TEXT}`}
  >
    {text(props.text)}
  </p>
)

const MarkDownRenderer: OpenUIComponentRenderer = ({ props }) => {
  const value = () => text(props.textMarkdown) ?? ""
  const variant = () => text(props.variant) ?? "clear"
  return (
    <div
      data-component="openui-markdown"
      class={
        variant() === "card"
          ? `${PANEL} px-4 py-3`
          : variant() === "sunk"
            ? `${PANEL_INSET} px-4 py-3`
            : ""
      }
      classList={{ "text-14-regular": true, [TEXT]: true }}
    >
      <Markdown text={value()} />
    </div>
  )
}

const Callout: OpenUIComponentRenderer = ({ props }) => (
  <Show when={props.visible !== false}>
    <div
      data-component="openui-callout"
      class={`flex flex-col gap-1 rounded-xl border px-4 py-3 ${CALLOUT[text(props.variant) ?? "neutral"] ?? CALLOUT.neutral}`}
    >
      <div data-slot="openui-callout-title" class={`text-14-medium ${TEXT}`}>
        {text(props.title)}
      </div>
      <div data-slot="openui-callout-description" class={`text-13-regular ${TEXT_MUTED}`}>
        {text(props.description)}
      </div>
    </div>
  </Show>
)

const TextCallout: OpenUIComponentRenderer = ({ props }) => (
  <div
    data-component="openui-text-callout"
    class={`flex flex-col gap-0.5 rounded-xl border px-3 py-2.5 ${CALLOUT[text(props.variant) ?? "neutral"] ?? CALLOUT.neutral}`}
  >
    <Show when={text(props.title)}>
      <div class={`text-13-medium ${TEXT}`}>{text(props.title)}</div>
    </Show>
    <Show when={text(props.description)}>
      <div class={`text-13-regular ${TEXT_MUTED}`}>{text(props.description)}</div>
    </Show>
  </div>
)

function Picture(props: { src: string; alt: string; class: string }) {
  return (
    <img
      data-component="openui-image"
      src={props.src}
      alt={props.alt}
      class={props.class}
      loading="lazy"
      onError={(event) => {
        // A generated URL that does not resolve must not leave a broken frame.
        event.currentTarget.hidden = true
        event.currentTarget.parentElement?.setAttribute("data-openui-image-error", "true")
      }}
    />
  )
}

const Image: OpenUIComponentRenderer = ({ props }) => {
  const src = text(props.src)
  if (!src) return <span data-component="openui-image-missing" class={`text-13-regular ${TEXT_FAINT}`}>{text(props.alt)}</span>
  return <Picture src={src} alt={text(props.alt) ?? ""} class="max-h-[320px] rounded-xl object-contain" />
}

const ImageBlock: OpenUIComponentRenderer = ({ props }) => (
  <Picture
    src={text(props.src) ?? ""}
    alt={text(props.alt) ?? ""}
    class={`w-full ${PANEL} object-contain`}
  />
)

const CodeBlock: OpenUIComponentRenderer = ({ props }) => {
  const language = text(props.language) ?? "text"
  const fenced = () => "```" + language + "\n" + (text(props.codeString) ?? "") + "\n```"
  return (
    <div data-component="openui-code-block">
      <Markdown text={fenced()} />
    </div>
  )
}

const InlineHeader: OpenUIComponentRenderer = ({ props }) => (
  <div data-component="openui-inline-header" class="flex flex-col gap-1">
    <div class={`text-16-medium ${TEXT}`}>{text(props.heading)}</div>
    <Show when={text(props.description)}>
      <div class={`text-13-regular ${TEXT_MUTED}`}>{text(props.description)}</div>
    </Show>
  </div>
)

/** `ListItem` and the other declaration shapes below are read by their parent. */
const Declaration: OpenUIComponentRenderer = () => null

const ListBlock: OpenUIComponentRenderer = ({ props }) => {
  const items = () => decls(props.items)
  const numbered = () => text(props.variant) === "number"
  const small = () => text(props.size) === "small"
  if (items().length === 0) return null
  return (
    <ul data-component="openui-list-block" class="flex flex-col gap-2">
      {items().map((item, index) => (
        <li class="flex items-start gap-2" classList={{ "opacity-90": small() }}>
          <Show when={numbered()}>
            <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-v2-background-bg-layer-02 text-11-medium text-v2-text-text-muted tabular-nums">
              {index + 1}
            </span>
          </Show>
          <Show when={!numbered() && text(decl(item.image)?.src)}>
            <Picture
              src={text(decl(item.image)?.src) ?? ""}
              alt={text(decl(item.image)?.alt) ?? ""}
              class="size-8 shrink-0 rounded-lg object-cover"
            />
          </Show>
          <div class="flex min-w-0 flex-1 flex-col">
            <span class={`text-14-medium ${TEXT}`}>{text(item.title)}</span>
            <Show when={text(item.subtitle)}>
              <span class={`text-13-regular ${TEXT_MUTED}`}>{text(item.subtitle)}</span>
            </Show>
          </div>
          <Show when={text(item.actionLabel)}>
            <span class="shrink-0 text-12-medium text-v2-text-text-accent">{text(item.actionLabel)}</span>
          </Show>
        </li>
      ))}
    </ul>
  )
}

const TagBlock: OpenUIComponentRenderer = ({ props }) => {
  const tags = () => (Array.isArray(props.tags) ? props.tags.flatMap((tag) => text(tag) ?? []) : [])
  if (tags().length === 0) return null
  const size = text(props.size) ?? "md"
  return (
    <div data-component="openui-tag-block" class="flex flex-wrap items-center gap-1.5">
      {tags().map((tag) => (
        <span
          class={`${PILL} bg-v2-background-bg-layer-02 px-2.5 py-0.5 ${TEXT} ${
            size === "sm" ? "text-11-regular" : size === "lg" ? "text-14-regular" : "text-12-regular"
          }`}
        >
          {tag}
        </span>
      ))}
    </div>
  )
}

const Tag: OpenUIComponentRenderer = ({ props, renderNode }) => {
  const size = text(props.size) ?? "md"
  return (
    <span
      data-component="openui-tag"
      class={`inline-flex items-center gap-1 ${PILL} px-2.5 py-0.5 ${
        TAG[text(props.variant) ?? "neutral"] ?? TAG.neutral
      } ${size === "sm" ? "text-11-regular" : size === "lg" ? "text-14-regular" : "text-12-regular"}`}
    >
      <Show when={props.icon}>
        <span class="inline-flex size-3 items-center justify-center">{renderNode(props.icon)}</span>
      </Show>
      {text(props.text)}
    </span>
  )
}

/**
 * A generated icon name from OpenUI's vocabulary, mapped onto the glyph this app
 * actually ships. An unmapped name draws nothing instead of the wrong picture.
 */
const Icon: OpenUIComponentRenderer = ({ props }) => {
  const name = () => legacyIconName(props.name)
  return (
    <Show when={name()}>
      <span data-component="openui-icon" class="inline-flex items-center justify-center text-current">
        <LegacyIcon name={name()!} size="small" />
      </span>
    </Show>
  )
}

const EntityList: OpenUIComponentRenderer = ({ props }) => {
  const rows = () => decls(props.rows)
  const header = () => decl(props.header)
  const footer = () => decl(props.footer)
  const small = () => text(props.size) === "small"
  const row = (item: Record<string, unknown>) => (
    <div class="flex items-baseline justify-between gap-3 border-b border-v2-border-border-muted py-2 last:border-b-0">
      <span class={`min-w-0 flex-1 truncate ${TEXT_MUTED} ${small() ? "text-12-regular" : "text-14-regular"}`}>
        {text(item.left)}
      </span>
      <span
        class={`shrink-0 ${TEXT} ${text(item.rightVariant) === "number" ? "tabular-nums" : ""} ${
          small() ? "text-12-medium" : "text-14-medium"
        }`}
      >
        {text(item.right)}
      </span>
    </div>
  )
  if (rows().length === 0 && !header() && !footer()) return null
  return (
    <div data-component="openui-entity-list" class="flex flex-col">
      <Show when={header()}>{(item) => <div class={`text-12-medium ${TEXT_MUTED}`}>{row(item())}</div>}</Show>
      {rows().map((item) => row(item))}
      <Show when={footer()}>{(item) => <div class={`text-12-medium ${TEXT_MUTED}`}>{row(item())}</div>}</Show>
    </div>
  )
}

function metric(props: Record<string, unknown>, bold: boolean) {
  const trend = decl(props.trend)
  const direction = text(trend?.direction)
  const amount = num(trend?.value)
  return (
    <span data-component="openui-metric" class="inline-flex items-baseline gap-2">
      <span class={`${bold ? "text-16-medium" : "text-16-regular"} ${TEXT} tabular-nums`}>
        {text(props.value)}
      </span>
      <Show when={text(props.subtext)}>
        <span class={`text-13-regular ${TEXT_MUTED}`}>{text(props.subtext)}</span>
      </Show>
      <Show when={direction !== undefined && amount !== undefined}>
        <span
          class={`text-12-medium ${direction === "down" ? "text-v2-state-fg-danger" : "text-v2-state-fg-success"}`}
        >
          {direction === "down" ? "↓" : "↑"} {amount}
          {String(amount).includes("%") ? "" : "%"}
        </span>
      </Show>
    </span>
  )
}

const Text: OpenUIComponentRenderer = ({ props }) => (
  <div data-component="openui-text" class="flex flex-col gap-0.5">
    <span
      class={`${TEXT_SIZE[text(props.size) ?? "md"] ?? TEXT_SIZE.md} ${TEXT} ${
        text(props.variant) === "number" ? "tabular-nums" : ""
      }`}
    >
      {text(props.value)}
    </span>
    <Show when={text(props.subtext)}>
      <span class={`text-13-regular ${TEXT_MUTED}`}>{text(props.subtext)}</span>
    </Show>
  </div>
)

const BoldText: OpenUIComponentRenderer = ({ props }) => (
  <div data-component="openui-bold-text" class="flex flex-col gap-0.5">
    <span
      class={`${TEXT_SIZE[text(props.size) ?? "md"] ?? TEXT_SIZE.md} font-medium ${TEXT} ${
        text(props.variant) === "number" ? "tabular-nums" : ""
      }`}
    >
      {text(props.value)}
    </span>
    <Show when={text(props.subtext)}>
      <span class={`text-13-regular ${TEXT_MUTED}`}>{text(props.subtext)}</span>
    </Show>
  </div>
)

const IconText: OpenUIComponentRenderer = ({ props, renderNode }) => {
  const vertical = () => text(props.layout) === "vertical"
  return (
    <div
      data-component="openui-icon-text"
      class="flex gap-2"
      classList={{ "flex-col items-start": vertical(), "items-center": !vertical() }}
    >
      <Show when={props.icon}>
        <span class="inline-flex size-5 shrink-0 items-center justify-center text-v2-icon-icon-base">
          {renderNode(props.icon)}
        </span>
      </Show>
      <div class="flex min-w-0 flex-col">
        <span class={`${bool(props.bold) ? "text-14-medium" : "text-14-regular"} ${TEXT}`}>
          {text(props.title)}
        </span>
        <Show when={text(props.subtitle)}>
          <span class={`text-13-regular ${TEXT_MUTED}`}>{text(props.subtitle)}</span>
        </Show>
      </div>
    </div>
  )
}

const MetricIndicatorInline: OpenUIComponentRenderer = ({ props }) => metric(props, true)

type ContentName =
  | "Card"
  | "CardHeader"
  | "TextContent"
  | "MarkDownRenderer"
  | "Callout"
  | "TextCallout"
  | "Image"
  | "ImageBlock"
  | "CodeBlock"
  | "InlineHeader"
  | "ListBlock"
  | "ListItem"
  | "TagBlock"
  | "Tag"
  | "Icon"
  | "EntityList"
  | "Text"
  | "BoldText"
  | "IconText"
  | "MetricIndicatorInline"

export const contentRenderers: Record<ContentName, OpenUIComponentRenderer> = {
  Card,
  CardHeader,
  TextContent,
  MarkDownRenderer,
  Callout,
  TextCallout,
  Image,
  ImageBlock,
  CodeBlock,
  InlineHeader,
  ListBlock,
  ListItem: Declaration,
  TagBlock,
  Tag,
  Icon,
  EntityList,
  Text,
  BoldText,
  IconText,
  MetricIndicatorInline,
}

export type { RenderInput }
