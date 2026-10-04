import { Match, onCleanup, onMount, Switch } from "solid-js"
import { animate, stagger } from "animejs"
import { observeAnimationVisibility } from "./animation-visibility"
import { ToolCheckmark } from "./tool-checkmark"
import "./tool-animations.css"

function SearchingWebLoop() {
  let ref: SVGSVGElement | undefined

  onMount(() => {
    if (ref === undefined) return
    const orbit = ref.querySelector("[data-orbit]")
    const ring = ref.querySelector("[data-ring]")
    const globe = Array.from(ref.querySelectorAll("[data-globe]"))
    const blips = Array.from(ref.querySelectorAll("[data-blip]"))
    if (orbit === null || ring === null) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      blips.forEach((blip) => blip.setAttribute("opacity", "0.8"))
      return
    }
    const spin = animate(orbit, { rotate: 360, duration: 2600, ease: "linear", loop: true })
    const pulse = animate(ring, {
      scale: [0.5, 1.7],
      opacity: [0.5, 0],
      duration: 900,
      ease: "outQuad",
      loop: true,
      delay: 200,
    })
    const breathe = animate(globe, {
      opacity: [0.35, 0.7],
      duration: 1300,
      ease: "inOutSine",
      loop: true,
      alternate: true,
    })
    const blip = animate(blips, {
      opacity: [0.15, 1],
      scale: [0.6, 1.5],
      duration: 240,
      ease: "outQuad",
      loop: true,
      alternate: true,
      delay: stagger(320, { start: 260 }),
    })
    const stopVisibility = observeAnimationVisibility(() => [spin, pulse, breathe, blip])
    onCleanup(() => {
      stopVisibility()
      spin.pause()
      pulse.pause()
      breathe.pause()
      blip.pause()
    })
  })

  return (
    <svg
      ref={ref}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      data-component="searching-web-animation"
      aria-hidden="true"
    >
      <circle data-globe cx="8" cy="8" r="5.2" stroke="currentColor" stroke-width="1" />
      <path
        data-globe
        d="M8 2.8 C5.4 4.9 5.4 11.1 8 13.2 C10.6 11.1 10.6 4.9 8 2.8"
        stroke="currentColor"
        stroke-width="0.9"
      />
      <path data-globe d="M2.9 8 H13.1" stroke="currentColor" stroke-width="0.9" />
      <circle data-blip cx="6" cy="6.3" r="0.85" fill="currentColor" opacity="0.2" />
      <circle data-blip cx="9.7" cy="10.5" r="0.85" fill="currentColor" opacity="0.2" />
      <circle data-blip cx="10.4" cy="6.9" r="0.85" fill="currentColor" opacity="0.2" />
      <circle data-ring cx="12.3" cy="5.5" r="2.2" stroke="currentColor" stroke-width="0.8" opacity="0" />
      <g data-orbit>
        <circle cx="12.3" cy="5.5" r="2.1" stroke="currentColor" stroke-width="1.1" />
        <path d="M13.9 3.9 L15.2 2.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      </g>
    </svg>
  )
}

export function SearchingWebAnimation(props: { status?: string }) {
  const running = () => props.status === "pending" || props.status === "running"
  return (
    <Switch>
      <Match when={running()}>
        <SearchingWebLoop />
      </Match>
      <Match when={props.status === "completed"}>
        <ToolCheckmark />
      </Match>
    </Switch>
  )
}
