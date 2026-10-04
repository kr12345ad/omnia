import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"

export interface AutoScrollOptions {
  working: () => boolean
  onUserInteracted?: () => void
  overflowAnchor?: "none" | "auto" | "dynamic"
  bottomThreshold?: number
}

function reducedMotion(): boolean {
  if (typeof window === "undefined") return true
  if (typeof window.matchMedia !== "function") return true
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function createAutoScroll(options: AutoScrollOptions) {
  let settling = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let autoTimer: ReturnType<typeof setTimeout> | undefined
  let auto: { top: number; time: number } | undefined
  let followFrame: number | undefined
  let followLast = 0

  const threshold = () => options.bottomThreshold ?? 10

  const [store, setStore] = createStore({
    contentRef: undefined as HTMLElement | undefined,
    scrollRef: undefined as HTMLElement | undefined,
    userScrolled: false,
  })

  const active = () => options.working() || settling

  const distanceFromBottom = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight - el.scrollTop
  }

  const canScroll = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight > 1
  }

  // Browsers can dispatch scroll events asynchronously. If new content arrives
  // between us calling `scrollTo()` and the subsequent `scroll` event firing,
  // the handler can see a non-zero `distanceFromBottom` and incorrectly assume
  // the user scrolled.
  const markAuto = (el: HTMLElement) => {
    auto = {
      top: Math.max(0, el.scrollHeight - el.clientHeight),
      time: Date.now(),
    }

    if (autoTimer) clearTimeout(autoTimer)
    autoTimer = setTimeout(() => {
      auto = undefined
      autoTimer = undefined
    }, 1500)
  }

  const isAuto = (el: HTMLElement) => {
    const a = auto
    if (!a) return false

    if (Date.now() - a.time > 1500) {
      auto = undefined
      return false
    }

    return Math.abs(el.scrollTop - a.top) < 2
  }

  const cancelFollow = () => {
    if (followFrame !== undefined) cancelAnimationFrame(followFrame)
    followFrame = undefined
  }

  // Follow the bottom with exponential smoothing instead of assigning the
  // position or restarting an animation per resize: each frame eases a fixed
  // fraction of the remaining distance, so streaming content produces one
  // continuous, genuinely fluid glide that never steps or snaps.
  const stepFollow = (now: number) => {
    const el = store.scrollRef
    if (!el) {
      cancelFollow()
      return
    }
    const dt = Math.min(64, Math.max(1, now - followLast))
    followLast = now
    const target = Math.max(0, el.scrollHeight - el.clientHeight)
    const distance = target - el.scrollTop
    if (Math.abs(distance) < 0.5) {
      el.scrollTop = target
      cancelFollow()
      return
    }
    el.scrollTop += distance * (1 - Math.exp(-dt / 90))
    followFrame = requestAnimationFrame(stepFollow)
  }

  const startFollow = () => {
    if (followFrame !== undefined) return
    followLast = performance.now()
    followFrame = requestAnimationFrame(stepFollow)
  }

  const scrollToBottomNow = (_behavior: ScrollBehavior) => {
    const el = store.scrollRef
    if (!el) return
    markAuto(el)
    if (reducedMotion()) {
      cancelFollow()
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
      return
    }
    startFollow()
  }

  const scrollToBottom = (force: boolean) => {
    if (!force && !active()) return

    if (force && store.userScrolled) setStore("userScrolled", false)

    const el = store.scrollRef
    if (!el) return

    if (!force && store.userScrolled) return

    const distance = distanceFromBottom(el)
    if (distance < 2) {
      markAuto(el)
      return
    }

    // For auto-following content we prefer immediate updates to avoid
    // visible "catch up" animations while content is still settling.
    scrollToBottomNow("auto")
  }

  const stop = () => {
    cancelFollow()
    const el = store.scrollRef
    if (!el) return
    if (!canScroll(el)) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }
    if (store.userScrolled) return

    setStore("userScrolled", true)
    options.onUserInteracted?.()
  }

  const handleWheel = (e: WheelEvent) => {
    if (e.deltaY >= 0) return
    // If the user is scrolling within a nested scrollable region (tool output,
    // code block, etc), don't treat it as leaving the "follow bottom" mode.
    // Those regions opt in via `data-scrollable`.
    const el = store.scrollRef
    const target = e.target instanceof Element ? e.target : undefined
    const nested = target?.closest("[data-scrollable]")
    if (el && nested && nested !== el) return
    stop()
  }

  const handleScroll = () => {
    const el = store.scrollRef
    if (!el) return

    // Ignore scroll events produced by our own follow loop.
    if (followFrame !== undefined) return

    if (!canScroll(el)) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }

    if (distanceFromBottom(el) < threshold()) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }

    // Ignore scroll events triggered by our own scrollToBottom calls.
    if (!store.userScrolled && isAuto(el)) {
      scrollToBottom(false)
      return
    }

    stop()
  }

  const handleInteraction = () => {
    if (!active()) return
    const selection = window.getSelection()
    if (selection && selection.toString().length > 0) {
      stop()
    }
  }

  const updateOverflowAnchor = (el: HTMLElement) => {
    const mode = options.overflowAnchor ?? "dynamic"

    if (mode === "none") {
      el.style.overflowAnchor = "none"
      return
    }

    if (mode === "auto") {
      el.style.overflowAnchor = "auto"
      return
    }

    el.style.overflowAnchor = store.userScrolled ? "auto" : "none"
  }

  createResizeObserver(
    () => store.contentRef,
    () => {
      const el = store.scrollRef
      if (el && !canScroll(el)) {
        if (store.userScrolled) setStore("userScrolled", false)
        return
      }
      if (!active()) return
      if (store.userScrolled) return
      // ResizeObserver fires after layout, before paint.
      // Keep the bottom locked in the same frame to avoid visible
      // "jump up then catch up" artifacts while streaming content.
      scrollToBottom(false)
    },
  )

  onCleanup(cancelFollow)

  createEffect(
    on(options.working, (working: boolean) => {
      settling = false
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = undefined

      if (working) {
        if (!store.userScrolled) scrollToBottom(true)
        return
      }

      settling = true
      settleTimer = setTimeout(() => {
        settling = false
      }, 300)
    }),
  )

  createEffect(() => {
    // Track `userScrolled` even before `scrollRef` is attached, so we can
    // update overflow anchoring once the element exists.
    store.userScrolled
    const el = store.scrollRef
    if (!el) return
    updateOverflowAnchor(el)
  })

  createEventListener(() => store.scrollRef, "wheel", handleWheel, { passive: true })

  onCleanup(() => {
    if (settleTimer) clearTimeout(settleTimer)
    if (autoTimer) clearTimeout(autoTimer)
  })

  return {
    scrollRef: (el: HTMLElement | undefined) => setStore("scrollRef", el),
    contentRef: (el: HTMLElement | undefined) => setStore("contentRef", el),
    handleScroll,
    handleInteraction,
    pause: stop,
    resume: () => {
      if (store.userScrolled) setStore("userScrolled", false)
      scrollToBottom(true)
    },
    scrollToBottom: () => scrollToBottom(false),
    forceScrollToBottom: () => scrollToBottom(true),
    userScrolled: () => store.userScrolled,
  }
}
