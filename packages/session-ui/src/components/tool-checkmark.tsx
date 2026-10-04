import { onCleanup, onMount } from "solid-js"
import { animate } from "animejs"
import "./tool-animations.css"

export function ToolCheckmark(props: { class?: string }) {
  let circle: SVGCircleElement | undefined
  let tick: SVGPathElement | undefined

  onMount(() => {
    if (circle === undefined || tick === undefined) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      tick.style.strokeDashoffset = "0"
      tick.style.opacity = "1"
      return
    }
    const draw = animate(tick, {
      strokeDashoffset: [12, 0],
      opacity: [0, 1],
      duration: 340,
      ease: "outCubic",
    })
    const pop = animate(circle, {
      scale: [0.55, 1],
      opacity: [0, 0.4],
      duration: 420,
      ease: "outBack",
    })
    onCleanup(() => {
      draw.pause()
      pop.pause()
    })
  })

  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      data-component="tool-checkmark"
      class={props.class}
      aria-hidden="true"
    >
      <circle ref={circle} cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.3" opacity="0" />
      <path
        ref={tick}
        d="M4.7 8.4 L7 10.6 L11.4 5.7"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        style={{ "stroke-dasharray": "12", "stroke-dashoffset": "12", opacity: "0" }}
      />
    </svg>
  )
}
