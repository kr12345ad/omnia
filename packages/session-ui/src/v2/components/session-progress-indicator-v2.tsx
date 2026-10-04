import { For, onCleanup, onMount, splitProps, type ComponentProps } from "solid-js"
import { createTimeline, stagger } from "animejs"
import { observeAnimationVisibility } from "../../components/animation-visibility"
import "./session-progress-indicator-v2.css"

const grid = 5
const dot = 2
const gap = 1
const origin = 1.5
const dots = Array.from({ length: grid * grid }, (_, index) => ({
  index,
  x: origin + (index % grid) * (dot + gap),
  y: origin + Math.floor(index / grid) * (dot + gap),
}))

export function SessionProgressIndicatorV2(props: ComponentProps<"svg">) {
  const [local, rest] = splitProps(props, ["class", "classList", "width", "height"])
  let ref: SVGSVGElement | undefined

  onMount(() => {
    if (ref === undefined) return
    const cells = Array.from(ref.querySelectorAll("[data-dot]"))
    if (cells.length === 0) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const core = ref.querySelector('[data-dot="12"]')
      if (core !== null) core.setAttribute("opacity", "1")
      return
    }
    const timeline = createTimeline({ loop: true, defaults: { ease: "inOutQuad" } })
    const wave = { opacity: 0.18, scale: 0.82 }
    const flash = { opacity: 1, scale: 1.55 }
    timeline
      .add(
        cells,
        {
          opacity: [{ to: flash.opacity, duration: 170 }, { to: wave.opacity, duration: 430 }],
          scale: [{ to: flash.scale, duration: 170 }, { to: wave.scale, duration: 430 }],
          delay: stagger(24, { grid: [grid, grid], from: "first" }),
        },
        0,
      )
      .add(
        cells,
        {
          opacity: [{ to: flash.opacity, duration: 150 }, { to: wave.opacity, duration: 400 }],
          scale: [{ to: flash.scale, duration: 150 }, { to: wave.scale, duration: 400 }],
          delay: stagger(24, { grid: [grid, grid], from: "last" }),
        },
        720,
      )
      .add(
        cells,
        {
          opacity: [{ to: 0.9, duration: 200 }, { to: wave.opacity, duration: 480 }],
          scale: [{ to: 1.35, duration: 200 }, { to: wave.scale, duration: 480 }],
          delay: stagger(26, { grid: [grid, grid], from: "center" }),
        },
        1440,
      )
    const stopVisibility = observeAnimationVisibility(() => [timeline])
    onCleanup(() => {
      stopVisibility()
      timeline.pause()
    })
  })

  return (
    <svg
      {...rest}
      ref={ref}
      class={local.class}
      classList={local.classList}
      width={local.width ?? 16}
      height={local.height ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-component="session-progress-indicator-v2"
      aria-hidden={rest["aria-hidden"] ?? "true"}
    >
      <For each={dots}>{(cell) => <rect data-dot={cell.index} x={cell.x} y={cell.y} width={dot} height={dot} />}</For>
    </svg>
  )
}
