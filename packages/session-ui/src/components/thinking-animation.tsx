import { onCleanup, onMount } from "solid-js"
import { animate, stagger } from "animejs"
import { observeAnimationVisibility } from "./animation-visibility"
import "./thinking-animation.css"

// A soft, breathing heartbeat instead of a mechanical spinner: the thinking
// indicator should feel like a person is considering something.
export function ThinkingAnimation(props: { class?: string }) {
  let ref: SVGSVGElement | undefined

  onMount(() => {
    if (ref === undefined) return
    const orb = ref.querySelector("[data-orb]")
    const halo = ref.querySelector("[data-halo]")
    const orbitA = ref.querySelector("[data-orbit-a]")
    const orbitB = ref.querySelector("[data-orbit-b]")
    const sparks = Array.from(ref.querySelectorAll("[data-spark]"))
    if (orb === null || halo === null || orbitA === null || orbitB === null) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

    const beat = animate(orb, {
      scale: [
        { to: 1.32, duration: 130, ease: "outQuad" },
        { to: 1, duration: 150, ease: "inQuad" },
        { to: 1.16, duration: 120, ease: "outQuad" },
        { to: 1, duration: 420, ease: "inOutSine" },
      ],
      loop: true,
      delay: 280,
    })
    const breathe = animate(halo, {
      scale: [0.7, 2.1],
      opacity: [0.5, 0],
      duration: 1400,
      ease: "outQuad",
      loop: true,
      delay: 280,
    })
    const spinA = animate(orbitA, { rotate: 360, duration: 3600, ease: "linear", loop: true })
    const spinB = animate(orbitB, { rotate: -360, duration: 5200, ease: "linear", loop: true })
    const twinkle = animate(sparks, {
      opacity: [0.3, 1],
      duration: 780,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      delay: stagger(240),
    })
    const stopVisibility = observeAnimationVisibility(() => [beat, breathe, spinA, spinB, twinkle])
    onCleanup(() => {
      stopVisibility()
      beat.pause()
      breathe.pause()
      spinA.pause()
      spinB.pause()
      twinkle.pause()
    })
  })

  return (
    <svg
      ref={ref}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      data-component="thinking-animation"
      class={props.class}
      aria-hidden="true"
    >
      <circle data-halo cx="8" cy="8" r="4.6" stroke="currentColor" stroke-width="1" opacity="0" />
      <g data-orbit-a>
        <circle data-spark cx="8" cy="3.3" r="0.75" fill="currentColor" opacity="0.4" />
      </g>
      <g data-orbit-b>
        <circle data-spark cx="8" cy="12.7" r="0.65" fill="currentColor" opacity="0.4" />
      </g>
      <circle data-orb cx="8" cy="8" r="3.1" fill="currentColor" />
      <circle cx="6.9" cy="6.9" r="1.1" fill="currentColor" opacity="0.45" />
    </svg>
  )
}
