import { useI18n } from "@opencode-ai/ui/context/i18n"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js"
import { decls, gap, text } from "../helpers"
import { DISABLED, FOCUS, HOVER, PANEL_ELEVATED, TEXT, TEXT_MUTED } from "../theme"
import type { OpenUIComponentRenderer } from "../types"

// OpenUI Lang layout components. `Stack` is the program root, so everything a
// model draws sits inside one of these.

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

/**
 * A flex container. Direction defaults to a column and gap to the library's
 * `m`, so an omitted prop still lays out the way the prompt describes.
 */
const Stack: OpenUIComponentRenderer = ({ props, renderNode }) => {
  const direction = () => (text(props.direction) === "row" ? "row" : "column")
  return (
    <div
      data-component="openui-stack"
      style={{
        display: "flex",
        "flex-direction": direction(),
        gap: gap(props.gap) ?? gap("m"),
        "align-items": ALIGN[text(props.align) ?? ""],
        "justify-content": JUSTIFY[text(props.justify) ?? ""],
        "flex-wrap": props.wrap === true ? "wrap" : undefined,
        "min-width": "0",
        width: "100%",
      }}
    >
      {renderNode(props.children)}
    </div>
  )
}

const Separator: OpenUIComponentRenderer = ({ props }) => {
  const vertical = () => text(props.orientation) === "vertical"
  return (
    <div
      data-component="openui-separator"
      role="separator"
      aria-orientation={vertical() ? "vertical" : "horizontal"}
      classList={{
        "w-full border-t border-v2-border-border-muted": !vertical(),
        "w-px self-stretch border-l border-v2-border-border-muted": vertical(),
      }}
    />
  )
}

/**
 * Tabs are client-side: the first item is selected until the reader picks
 * another one. Each `TabItem` arrives as a declaration node, so its `content`
 * is rendered from the declaration rather than from a rendered child.
 *
 * A generated tab set draws the app's own segmented control — layer surface,
 * hairline outline, the active segment lifted onto the base surface — because a
 * model choosing between views is the same choice the app's controls offer.
 */
const Tabs: OpenUIComponentRenderer = ({ props, renderNode }) => {
  const items = createMemo(() => decls(props.items))
  const [selected, setSelected] = createSignal<string>()
  const id = createUniqueId()
  const activeValue = () => text(selected() === undefined ? items()[0]?.value : selected()) ?? ""
  const active = createMemo(() => items().find((item) => text(item.value) === activeValue()))

  return (
    <div data-component="openui-tabs" class="flex w-full min-w-0 flex-col gap-3">
      <div
        role="tablist"
        class="inline-flex max-w-full items-center self-start overflow-x-auto rounded-md bg-v2-background-bg-layer-01 shadow-[0_0_0_0.5px_var(--v2-border-border-base)]"
      >
        <For each={items()}>
          {(item, index) => {
            const value = () => text(item.value) ?? `item-${index()}`
            const selected = () => text(item.value) === activeValue()
            return (
              <button
                type="button"
                role="tab"
                id={`openui-tab-${id}-${value()}`}
                aria-selected={selected()}
                aria-controls={`openui-tabpanel-${id}-${value()}`}
                tabIndex={selected() ? 0 : -1}
                class={`h-7 shrink-0 rounded-md px-3 text-13-regular transition-colors ${FOCUS}`}
                classList={{
                  "bg-v2-background-bg-base text-v2-text-text-base shadow-[0_0_0_0.5px_var(--v2-border-border-strong)]":
                    selected(),
                  "text-v2-text-text-muted hover:text-v2-text-text-base": !selected(),
                }}
                onClick={() => setSelected(value())}
              >
                {text(item.trigger) ?? ""}
              </button>
            )
          }}
        </For>
      </div>
      <div
        role="tabpanel"
        id={`openui-tabpanel-${id}-${activeValue()}`}
        aria-labelledby={`openui-tab-${id}-${activeValue()}`}
        data-component="openui-tab-panel"
        class="flex min-w-0 flex-col gap-2"
      >
        {renderNode(active()?.content)}
      </div>
    </div>
  )
}

/** Declaration shape read by `Steps`; it never draws on its own. */
const TabItem: OpenUIComponentRenderer = () => null

const Steps: OpenUIComponentRenderer = ({ props }) => {
  const items = createMemo(() => decls(props.items))
  return (
    <ol data-component="openui-steps" class="flex w-full min-w-0 flex-col gap-3">
      <For each={items()}>
        {(item, index) => (
          <li class="flex w-full min-w-0 items-start gap-3">
            <span class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-v2-background-bg-layer-02 text-11-medium text-v2-text-text-muted">
              {index() + 1}
            </span>
            <span class="flex min-w-0 flex-col gap-0.5">
              <span class={`text-14-medium ${TEXT}`}>{text(item.title) ?? ""}</span>
              <span class={`text-12-regular ${TEXT_MUTED}`}>{text(item.details) ?? ""}</span>
            </span>
          </li>
        )}
      </For>
    </ol>
  )
}

/** Declaration shape read by `Steps`. */
const StepsItem: OpenUIComponentRenderer = () => null

/**
 * A modal is inline in a chat message, so it renders as a labelled panel
 * instead of a backdrop dialog: an overlay would fight the transcript's scroll
 * and land outside the message it belongs to. Only an explicit `open === false`
 * hides it, and the close control hides it locally.
 */
const Modal: OpenUIComponentRenderer = ({ props, renderNode }) => {
  const i18n = useI18n()
  const [dismissed, setDismissed] = createSignal(false)
  const open = () => !dismissed() && props.open !== false

  return (
    <Show when={open()}>
      <div
        data-component="openui-modal"
        data-size={text(props.size) ?? "md"}
        class={`my-1 flex w-full min-w-0 flex-col overflow-hidden ${PANEL_ELEVATED}`}
      >
        <div class="flex w-full items-center justify-between gap-3 border-b border-v2-border-border-muted px-4 py-2.5">
          <span class={`text-14-medium ${TEXT}`}>{text(props.title) ?? ""}</span>
          <button
            type="button"
            aria-label={i18n.t("ui.common.close")}
            class={`flex size-6 shrink-0 items-center justify-center rounded-md ${TEXT_MUTED} ${HOVER} ${FOCUS} ${DISABLED} hover:text-v2-text-text-base`}
            onClick={() => setDismissed(true)}
          >
            <Icon name="close" size="small" />
          </button>
        </div>
        <div class="flex min-w-0 flex-col gap-3 p-4">{renderNode(props.children)}</div>
      </div>
    </Show>
  )
}

type LayoutName = "Stack" | "Separator" | "Tabs" | "TabItem" | "Steps" | "StepsItem" | "Modal"

export const layoutRenderers: Record<LayoutName, OpenUIComponentRenderer> = {
  Stack,
  Separator,
  Tabs,
  TabItem,
  Steps,
  StepsItem,
  Modal,
}
