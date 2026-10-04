import { For, Index, createEffect, createMemo, on } from "solid-js"
import { createStore } from "solid-js/store"

const TRACK = Array.from({ length: 30 }, (_, index) => index % 10)
const DURATION = 600

function normalize(value: number) {
  return ((value % 10) + 10) % 10
}

function spin(from: number, to: number, direction: 1 | -1) {
  if (from === to) return 0
  if (direction > 0) return (to - from + 10) % 10
  return -((from - to + 10) % 10)
}

function reducedMotion() {
  if (typeof window === "undefined") return true
  if (typeof window.matchMedia !== "function") return true
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/**
 * The offset selects one cell of `TRACK`, and the digit only stays on screen while that offset is
 * inside `[10, 20)` — outside it every cell sits outside the masked 1em window and renders blank.
 * Renormalizing relies on a transitionend that never arrives under reduced motion (the CSS zeroes
 * the duration) or when the transition is interrupted, so the offset is snapped in those cases and
 * only spun while it provably lands back inside the window.
 */
export function animatedNumberStep(input: {
  step: number
  from: number
  to: number
  direction: 1 | -1
  reducedMotion: boolean
}) {
  const delta = spin(input.from, input.to, input.direction)
  if (!delta || input.reducedMotion) return { step: input.to + 10, animating: false }
  const step = input.step + delta
  if (step < 10 || step >= 20) return { step: input.to + 10, animating: false }
  return { step, animating: true }
}

function Digit(props: { value: number; direction: 1 | -1 }) {
  const [state, setState] = createStore({
    step: props.value + 10,
    animating: false,
  })
  const step = () => state.step
  const animating = () => state.animating
  let last = props.value

  createEffect(
    on(
      () => props.value,
      (next) => {
        const update = animatedNumberStep({
          step: step(),
          from: last,
          to: next,
          direction: props.direction,
          reducedMotion: reducedMotion(),
        })
        last = next
        setState(update)
      },
      { defer: true },
    ),
  )

  const settle = () => setState({ animating: false, step: normalize(step()) + 10 })

  return (
    <span data-slot="animated-number-digit">
      <span
        data-slot="animated-number-strip"
        data-animating={animating() ? "true" : "false"}
        onTransitionEnd={settle}
        onTransitionCancel={settle}
        style={{
          "--animated-number-offset": `${step()}`,
          "--animated-number-duration": `var(--tool-motion-odometer-ms, ${DURATION}ms)`,
        }}
      >
        <For each={TRACK}>{(value) => <span data-slot="animated-number-cell">{value}</span>}</For>
      </span>
    </span>
  )
}

export function AnimatedNumber(props: { value: number; class?: string }) {
  const target = createMemo(() => {
    if (!Number.isFinite(props.value)) return 0
    return Math.max(0, Math.round(props.value))
  })

  const [state, setState] = createStore({
    value: target(),
    direction: 1 as 1 | -1,
  })
  const value = () => state.value
  const direction = () => state.direction

  createEffect(
    on(
      target,
      (next) => {
        const current = value()
        if (next === current) return

        setState("direction", next > current ? 1 : -1)
        setState("value", next)
      },
      { defer: true },
    ),
  )

  const label = createMemo(() => value().toString())
  const digits = createMemo(() =>
    Array.from(label(), (char) => {
      const code = char.charCodeAt(0) - 48
      if (code < 0 || code > 9) return 0
      return code
    }).reverse(),
  )
  const width = createMemo(() => `${digits().length}ch`)

  return (
    <span data-component="animated-number" class={props.class} aria-label={label()}>
      <span data-slot="animated-number-value" style={{ "--animated-number-width": width() }}>
        <Index each={digits()}>{(digit) => <Digit value={digit()} direction={direction()} />}</Index>
      </span>
    </span>
  )
}
