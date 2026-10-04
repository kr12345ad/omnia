export function clampScrollTop(element: HTMLElement, target: number): number {
  return Math.max(0, Math.min(target, element.scrollHeight - element.clientHeight))
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true
  if (typeof window.matchMedia !== "function") return true
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export interface SmoothScroll {
  to(target: number, options?: { duration?: number }): void
  toEnd(options?: { duration?: number }): void
  cancel(): void
  animating(): boolean
}

// Auto-follow during streaming is a stream of small scroll adjustments.
// Exponential smoothing eases a fixed fraction of the remaining distance each
// frame, so the view glides continuously with the content instead of stepping
// or restarting an animation on every resize.
export function createSmoothScroll(
  getElement: () => HTMLElement | null,
  options?: { reducedMotion?: () => boolean },
): SmoothScroll {
  const reducedMotion = options?.reducedMotion ?? prefersReducedMotion
  let frame: number | undefined
  let last = 0
  let target = 0

  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  }

  const step = (now: number) => {
    const element = getElement()
    if (element === null) {
      cancel()
      return
    }
    const dt = Math.min(64, Math.max(1, now - last))
    last = now
    const distance = target - element.scrollTop
    if (Math.abs(distance) < 0.5) {
      element.scrollTop = target
      cancel()
      return
    }
    element.scrollTop += distance * (1 - Math.exp(-dt / 90))
    frame = requestAnimationFrame(step)
  }

  const to = (next: number) => {
    const element = getElement()
    if (element === null) return
    const clamped = clampScrollTop(element, next)
    cancel()
    if (Math.abs(element.scrollTop - clamped) < 1 || reducedMotion()) {
      element.scrollTop = clamped
      return
    }
    target = clamped
    last = performance.now()
    frame = requestAnimationFrame(step)
  }

  const toEnd = () => {
    const element = getElement()
    if (element === null) return
    to(element.scrollHeight - element.clientHeight)
  }

  return { to, toEnd, cancel, animating: () => frame !== undefined }
}
