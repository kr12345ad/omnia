import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Show } from "solid-js"
import { decl, text } from "../helpers"
import { v2IconName } from "../icons"
import type { OpenUIComponentRenderer, OpenUIRendererMap } from "../types"

/** OpenUI's three emphasis levels onto the app's own button variants. */
const VARIANTS: Record<string, "contrast" | "neutral" | "ghost" | "danger"> = {
  primary: "contrast",
  secondary: "neutral",
  tertiary: "ghost",
}

const SIZES: Record<string, "small" | "normal" | "large"> = {
  "extra-small": "small",
  small: "small",
  medium: "normal",
  large: "large",
}

/**
 * Buttons are the one interactive component this build implements.
 *
 * An action arrives as the language's unevaluated AST rather than as resolved
 * props, so `@ToAssistant("…")` — directly on the button or as a step of
 * `Action([…])` — is read here. A click sends that message to the conversation;
 * a button with no action at all sends its label, which is what the prompt
 * documents. An action this build cannot run (`@OpenUrl`, a step list with no
 * message) leaves the button inert instead of putting the label's words in the
 * user's mouth.
 */
type ActionNode = { k?: string; name?: string; args?: unknown[] }

function actionNode(value: unknown): ActionNode | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const node = value as ActionNode
  return node.k === "Comp" ? node : undefined
}

/** The syntax tree wraps literals, so a string argument arrives as `{ k: "Str", v }`. */
function literal(value: unknown) {
  if (typeof value !== "object" || value === null) return text(value)
  const node = value as { k?: string; v?: unknown }
  return node.k === "Str" || node.k === "Num" || node.k === "Bool" ? text(node.v) : undefined
}

/** The steps an action runs: the step itself, or the steps inside `Action([…])`. */
function actionSteps(value: unknown): ActionNode[] {
  const node = actionNode(value)
  if (!node) return []
  if (node.name !== "Action") return [node]
  const list = node.args?.[0] as { k?: string; els?: unknown[] } | undefined
  if (list?.k !== "Arr" || !Array.isArray(list.els)) return []
  return list.els.flatMap((step) => actionNode(step) ?? [])
}

function actionMessage(action: unknown, label: string) {
  if (action === undefined || action === null) return label
  for (const step of actionSteps(action)) {
    if (step.name !== "ToAssistant") continue
    const message = literal(step.args?.[0])
    if (message !== undefined && message.trim().length > 0) return message
  }
  return undefined
}

function variantOf(props: Record<string, unknown>) {
  if (text(props.type) === "destructive") return "danger" as const
  return VARIANTS[text(props.variant) ?? ""] ?? ("neutral" as const)
}

function sizeOf(props: Record<string, unknown>) {
  return SIZES[text(props.size) ?? ""] ?? ("normal" as const)
}

const Button: OpenUIComponentRenderer = ({ props, onAction }) => {
  const label = () => text(props.label) ?? ""
  const send = () => {
    const message = actionMessage(props.action, label())
    if (message !== undefined) onAction?.(message)
  }
  return (
    <span data-component="openui-button">
      <ButtonV2 variant={variantOf(props)} size={sizeOf(props)} onClick={send}>
        {label()}
      </ButtonV2>
    </span>
  )
}

const Buttons: OpenUIComponentRenderer = ({ props, renderNode }) => (
  <div
    data-component="openui-buttons"
    style={{
      display: "flex",
      "flex-direction": text(props.direction) === "column" ? "column" : "row",
      "flex-wrap": "wrap",
      "align-items": "center",
      gap: "0.5rem",
      "min-width": "0",
    }}
  >
    {renderNode(props.buttons)}
  </div>
)

const IconButton: OpenUIComponentRenderer = ({ props, onAction }) => {
  const label = () => text(props.name) ?? ""
  const icon = () => v2IconName(decl(props.icon)?.name)
  const resolvedSize = () => {
    const size = sizeOf(props)
    return size === "normal" ? "small" : size
  }
  const send = () => {
    const message = actionMessage(props.action, label())
    if (message !== undefined) onAction?.(message)
  }
  return (
    <span data-component="openui-icon-button">
      <ButtonV2
        variant={variantOf(props)}
        size={resolvedSize()}
        icon={icon()}
        aria-label={label()}
        classList={{ "rounded-full": text(props.shape) === "circle" }}
        onClick={send}
      >
        <Show when={!icon()}>{label()}</Show>
      </ButtonV2>
    </span>
  )
}

type ActionName = "Buttons" | "Button" | "IconButton"

export const actionRenderers: Record<ActionName, OpenUIComponentRenderer> = {
  Buttons,
  Button,
  IconButton,
}
