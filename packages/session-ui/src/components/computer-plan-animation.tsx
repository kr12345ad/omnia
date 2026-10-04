import { Match, onCleanup, onMount, Switch } from "solid-js"
import { animate, createTimeline, stagger } from "animejs"
import { observeAnimationVisibility } from "./animation-visibility"
import { ToolCheckmark } from "./tool-checkmark"
import "./tool-animations.css"

function ComputerPlanLoop() {
  let ref: SVGSVGElement | undefined

  onMount(() => {
    if (ref === undefined) return
    const ticks = Array.from(ref.querySelectorAll("[data-tick]"))
    const checks = Array.from(ref.querySelectorAll("[data-check]"))
    const lines = Array.from(ref.querySelectorAll("[data-line]"))
    const caret = ref.querySelector("[data-caret]")
    if (caret === null) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      ticks.forEach((tick) => tick.setAttribute("stroke-dashoffset", "0"))
      return
    }
    const timeline = createTimeline({ loop: true, defaults: { ease: "outCubic" } })
    timeline
      .add(
        ticks,
        { strokeDashoffset: [4.6, 0], duration: 220, delay: stagger(480, { start: 260 }) },
        0,
      )
      .add(
        checks,
        { opacity: [0.18, 1], scale: [0.7, 1], duration: 220, delay: stagger(480, { start: 260 }) },
        0,
      )
      .add(
        lines,
        { opacity: [0.22, 0.7], duration: 260, delay: stagger(480, { start: 260 }) },
        0,
      )
      .add(caret, { y: [0, 2.5, 5], duration: 1440, ease: "steps(3)" }, 160)
      .add(caret, { opacity: [1, 0], duration: 200 }, 1700)
      .add([ticks, checks, lines], { opacity: 0, duration: 240 }, 2050)
    const stopVisibility = observeAnimationVisibility(() => [timeline])
    onCleanup(() => {
      stopVisibility()
      timeline.pause()
    })
  })

  return (
    <svg
      ref={ref}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      data-component="computer-plan-animation"
      aria-hidden="true"
    >
      <rect data-screen x="1.3" y="2.6" width="13.4" height="9.2" rx="1.6" stroke="currentColor" stroke-width="1" />
      <path data-stand d="M8 11.8 V13.4" stroke="currentColor" stroke-width="1" />
      <path data-stand d="M5.9 13.9 H10.1" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
      <rect data-check x="3" y="4.2" width="2.6" height="2.6" rx="0.7" stroke="currentColor" stroke-width="0.9" opacity="0.18" />
      <path
        data-tick
        d="M3.4 5.5 L4.2 6.3 L5.5 4.7"
        stroke="currentColor"
        stroke-width="1.1"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-dasharray="4.6"
        stroke-dashoffset="4.6"
      />
      <path data-line d="M6.6 5.5 H12.4" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.22" />
      <rect data-check x="3" y="6.7" width="2.6" height="2.6" rx="0.7" stroke="currentColor" stroke-width="0.9" opacity="0.18" />
      <path
        data-tick
        d="M3.4 8 L4.2 8.8 L5.5 7.2"
        stroke="currentColor"
        stroke-width="1.1"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-dasharray="4.6"
        stroke-dashoffset="4.6"
      />
      <path data-line d="M6.6 8 H11.6" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.22" />
      <rect data-check x="3" y="9.2" width="2.6" height="2.6" rx="0.7" stroke="currentColor" stroke-width="0.9" opacity="0.18" />
      <path
        data-tick
        d="M3.4 10.5 L4.2 11.3 L5.5 9.7"
        stroke="currentColor"
        stroke-width="1.1"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-dasharray="4.6"
        stroke-dashoffset="4.6"
      />
      <path data-line d="M6.6 10.5 H13" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.22" />
      <rect data-caret x="1.1" y="4.3" width="0.9" height="2.4" rx="0.4" fill="currentColor" />
    </svg>
  )
}

export function ComputerPlanAnimation(props: { status?: string }) {
  const running = () => props.status === "pending" || props.status === "running"
  return (
    <Switch>
      <Match when={running()}>
        <ComputerPlanLoop />
      </Match>
      <Match when={props.status === "completed"}>
        <ToolCheckmark />
      </Match>
    </Switch>
  )
}
