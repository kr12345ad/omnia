import { createStreamingParser } from "@openuidev/lang-core"
import {
  OPENUI_ROOT,
  OPENUI_SCHEMA,
  isOpenUIElement,
  mergeOpenUISchema,
  type OpenUIParseResult,
} from "@opencode-ai/core/openui"
import { createMemo, Show, type JSX } from "solid-js"
import { openuiExtensionRenderers, openuiRenderers } from "./registry"
import { PANEL, TEXT_MUTED } from "./theme"
import type { OpenUIElement } from "./types"

type ParserSchema = Parameters<typeof createStreamingParser>[0]

// The generated document plus this build's own components (`extensions.ts`) is
// the same JSON Schema language `createStreamingParser` validates against; the
// cast only bridges the two copies of that shape.
const schema = mergeOpenUISchema(OPENUI_SCHEMA) as unknown as ParserSchema

/**
 * Renders a block of OpenUI Lang.
 *
 * The parser is streaming: every change re-parses the accumulated text and
 * resolves references as their statements arrive, so partial output draws the
 * structure first and fills it in — no separate "loading" state.
 *
 * `onAction` receives the human-readable message of a generated button. The
 * caller decides what that means (the chat surfaces send it as the next turn).
 * Without it buttons render but do nothing.
 */
export function OpenUIRender(props: {
  code: string
  streaming?: boolean
  class?: string
  onAction?: (message: string) => void
}) {
  const parser = createStreamingParser(schema, OPENUI_ROOT)
  const result = createMemo<OpenUIParseResult>(() => parser.set(props.code) as unknown as OpenUIParseResult)
  const renderNode = (value: unknown) => renderValue(value, props.onAction)

  return (
    <div data-component="openui" class={`flex min-w-0 flex-col gap-3 ${props.class ?? ""}`}>
      <Show when={result().root} fallback={<Show when={!props.streaming}>{renderFallback(props.code)}</Show>}>
        {(root) => <>{renderNode(root())}</>}
      </Show>
    </div>
  )
}

/** The generated program did not parse: show the source rather than lose the answer. */
function renderFallback(code: string) {
  if (!code.trim()) return null
  return (
    <pre
      data-component="openui-fallback"
      class={`my-2 overflow-x-auto p-3 text-12-regular ${PANEL} ${TEXT_MUTED}`}
    >
      {code}
    </pre>
  )
}

function renderValue(value: unknown, onAction?: (message: string) => void): JSX.Element {
  if (value === null || value === undefined || value === false) return null
  if (isOpenUIElement(value)) return renderElement(value, onAction)
  if (Array.isArray(value)) return <>{value.map((item) => renderValue(item, onAction))}</>
  if (typeof value === "string" || typeof value === "number") return String(value)
  if (typeof value === "boolean") return value ? "true" : null
  return null
}

/**
 * A renderer by component name.
 *
 * The parser validates against the library this build ships, but a program can
 * still name a component from a newer library, so the lookup stays total and an
 * unknown name draws the unsupported marker instead of throwing.
 */
function rendererFor(name: string) {
  if (Object.hasOwn(openuiExtensionRenderers, name)) return openuiExtensionRenderers[name]
  if (!Object.hasOwn(openuiRenderers, name)) return undefined
  return openuiRenderers[name as keyof typeof openuiRenderers]
}

function renderElement(node: OpenUIElement, onAction?: (message: string) => void): JSX.Element {
  const renderer = rendererFor(node.typeName)
  if (!renderer) return <UnsupportedComponent name={node.typeName} />
  return renderer({
    props: node.props,
    renderNode: (value) => renderValue(value, onAction),
    onAction,
  }) as JSX.Element
}

/**
 * A component the library no longer declares, or one from a newer library than
 * this build. It stays visible so a mismatch is obvious instead of silent.
 */
function UnsupportedComponent(props: { name: string }) {
  return (
    <div data-component="openui-unsupported" class={`my-1 px-4 py-2.5 text-12-regular ${PANEL} ${TEXT_MUTED}`}>
      {props.name}
    </div>
  )
}
