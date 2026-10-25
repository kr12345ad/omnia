import { For, createMemo, createSignal } from "solid-js"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import type { PromptInputV2Option } from "./types"
import { promptInputV2VariantPosition, promptInputV2VariantStop } from "./variant-slider-geometry"
import "./variant-slider.css"

export function PromptInputV2VariantSlider(props: {
  title: string
  keybind?: string[]
  options: PromptInputV2Option[]
  current: string
  onSelect: (id: string) => void
  class?: string
}) {
  const stops = createMemo(() => props.options.length)
  const seeded = createMemo(() => {
    const at = props.options.findIndex((option) => option.id === props.current)
    return at === -1 ? 0 : at
  })
  // While the pointer is down the thumb tracks it; outside a drag the thumb
  // sits exactly on the selected stop.
  const [dragging, setDragging] = createSignal(false)
  const [position, setPosition] = createSignal<number>()
  const ratio = createMemo(() => {
    const live = position()
    if (live !== undefined) return live
    return stops() <= 1 ? 0 : seeded() / (stops() - 1)
  })
  const shown = createMemo(() => (dragging() ? promptInputV2VariantStop(ratio(), stops()) : seeded()))
  const label = createMemo(() => props.options[shown()]?.label ?? props.current)
  let rail: HTMLDivElement | undefined

  const track = (clientX: number) => {
    if (rail === undefined) return
    const box = rail.getBoundingClientRect()
    const rtl = getComputedStyle(rail).direction === "rtl"
    setPosition(promptInputV2VariantPosition(clientX, box, rtl))
  }
  const commit = (index: number) => {
    const option = props.options[index]
    if (option !== undefined && option.id !== props.current) props.onSelect(option.id)
  }
  const finish = () => {
    if (!dragging()) return
    setDragging(false)
    commit(promptInputV2VariantStop(ratio(), stops()))
    setPosition(undefined)
  }
  const step = (delta: number) => {
    const next = promptInputV2VariantStop(
      stops() <= 1 ? 0 : (shown() + delta) / (stops() - 1),
      stops(),
    )
    commit(next)
  }

  return (
    <TooltipV2
      placement="top"
      value={
        <>
          {props.title}
          <KeybindV2 keys={props.keybind ?? []} variant="neutral" />
        </>
      }
    >
      <div
        data-component="prompt-variant-slider"
        data-dragging={dragging() ? "" : undefined}
        class={`group/variant flex h-7 max-w-[220px] shrink-0 items-center gap-2 rounded-full pe-2 ps-2.5 ${props.class ?? ""}`}
      >
        <div
          ref={rail}
          role="slider"
          tabindex={0}
          aria-label={props.title}
          aria-valuemin={0}
          aria-valuemax={stops() - 1}
          aria-valuenow={shown()}
          aria-valuetext={label()}
          class="relative h-7 w-14 shrink-0 cursor-pointer touch-none outline-none"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            setDragging(true)
            track(event.clientX)
          }}
          onPointerMove={(event) => {
            if (!dragging()) return
            track(event.clientX)
          }}
          onPointerUp={(event) => {
            track(event.clientX)
            event.currentTarget.releasePointerCapture(event.pointerId)
            finish()
          }}
          onPointerCancel={finish}
          onLostPointerCapture={finish}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowUp") {
              event.preventDefault()
              step(1)
              return
            }
            if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
              event.preventDefault()
              step(-1)
              return
            }
            if (event.key === "Home") {
              event.preventDefault()
              commit(0)
              return
            }
            if (event.key === "End") {
              event.preventDefault()
              commit(stops() - 1)
            }
          }}
        >
          <div data-slot="variant-rail" class="absolute inset-x-1.5 top-1/2 h-[3px] -translate-y-1/2 rounded-full" />
          <div
            data-slot="variant-fill"
            class="absolute start-1.5 top-1/2 h-[3px] -translate-y-1/2 rounded-full"
            style={{ width: `calc((100% - 12px) * ${ratio()})` }}
          />
          <For each={props.options}>
            {(option, index) => (
              <span
                data-slot="variant-stop"
                class="absolute top-1/2 size-[3px] -translate-y-1/2 rounded-full"
                classList={{ "data-current": index() === shown() }}
                style={{
                  "inset-inline-start": `calc(6px + (100% - 12px) * ${stops() <= 1 ? 0 : index() / (stops() - 1)})`,
                }}
                aria-hidden="true"
              />
            )}
          </For>
          <span
            data-slot="variant-thumb"
            class="absolute top-1/2 size-[11px] -translate-y-1/2 rounded-full"
            style={{ "inset-inline-start": `calc(6px + (100% - 12px) * ${ratio()})` }}
          />
        </div>
        <span class="min-w-0 truncate text-[12px] font-[440] leading-5 capitalize" data-slot="variant-label">
          {label()}
        </span>
      </div>
    </TooltipV2>
  )
}
