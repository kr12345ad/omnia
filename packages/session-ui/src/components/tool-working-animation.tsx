import { Match, onCleanup, onMount, Switch } from "solid-js"
import { animate } from "animejs"
import { observeAnimationVisibility } from "./animation-visibility"
import { ToolCheckmark } from "./tool-checkmark"
import "./tool-animations.css"

function ToolWorkingLoop() {
  let ref: SVGSVGElement | undefined

  onMount(() => {
    if (ref === undefined) return
    const spin = ref.querySelector("[data-spin]")
    const core = ref.querySelector("[data-core]")
    if (spin === null || core === null) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const rotate = animate(spin, { rotate: 360, duration: 1000, ease: "linear", loop: true })
    const pulse = animate(core, {
      scale: [0.7, 1.5],
      opacity: [0.35, 1],
      duration: 500,
      ease: "inOutSine",
      loop: true,
      alternate: true,
    })
    const stopVisibility = observeAnimationVisibility(() => [rotate, pulse])
    onCleanup(() => {
      stopVisibility()
      rotate.pause()
      pulse.pause()
    })
  })

  return (
    <svg
      ref={ref}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      data-component="tool-working-animation"
      aria-hidden="true"
    >
      <circle data-track cx="8" cy="8" r="5.6" stroke="currentColor" stroke-width="1.3" opacity="0.18" />
      <g data-spin>
        <path
          d="M8 2.4 A5.6 5.6 0 0 1 13.4 7"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
        <circle cx="13.4" cy="7" r="0.9" fill="currentColor" />
      </g>
      <circle data-core cx="8" cy="8" r="1.5" fill="currentColor" opacity="0.35" />
    </svg>
  )
}

export function ToolWorkingAnimation(props: { status?: string }) {
  const running = () => props.status === "pending" || props.status === "running"
  return (
    <Switch>
      <Match when={running()}>
        <ToolWorkingLoop />
      </Match>
      <Match when={props.status === "completed"}>
        <ToolCheckmark />
      </Match>
    </Switch>
  )
}
