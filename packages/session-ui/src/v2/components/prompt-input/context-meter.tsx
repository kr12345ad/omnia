import { createMemo } from "solid-js"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { contextPressure, formatContextTokens } from "./context-meter-format"
import "./context-meter.css"

export { contextPressure, formatContextTokens }

const count = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0)

export function PromptInputV2ContextMeter(props: { used: number; limit?: number; label: string }) {
  // The readout moves with the conversation. A spring keeps streamed deltas
  // from snapping the digits, and retargeting mid-flight keeps it chasing the
  // latest count instead of replaying every intermediate value.
  const displayed = useSpring(() => count(props.used), { visualDuration: 0.35, bounce: 0 })
  const compact = createMemo(() => formatContextTokens(Math.round(displayed())))
  const exact = createMemo(() => count(props.used).toLocaleString())
  const limit = createMemo(() => (props.limit === undefined ? undefined : count(props.limit).toLocaleString()))
  const percent = createMemo(() => {
    const total = props.limit === undefined ? 0 : count(props.limit)
    if (total <= 0) return undefined
    return Math.min(100, Math.max(0, Math.round((count(props.used) / total) * 100)))
  })
  const pressure = createMemo(() => contextPressure(props.used, props.limit))
  const value = createMemo(() => {
    const total = limit() === undefined ? exact() : `${exact()} / ${limit()}`
    return percent() === undefined ? `${props.label}: ${total}` : `${props.label}: ${total} (${percent()}%)`
  })

  return (
    <TooltipV2 placement="top" value={value()}>
      <span
        data-component="prompt-context-meter"
        data-pressure={pressure()}
        tabindex={0}
        aria-label={value()}
        aria-live="off"
        class="flex h-7 shrink-0 items-center rounded-full px-2 tabular-nums"
      >
        <span data-slot="context-meter-value">{compact()}</span>
      </span>
    </TooltipV2>
  )
}
