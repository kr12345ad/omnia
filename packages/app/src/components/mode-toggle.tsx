import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount } from "solid-js"
import { animate } from "animejs"
import { Icon } from "@opencode-ai/ui/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import type { SessionMode } from "@/utils/session-mode"

const MODES = [
  { id: "work", icon: "window-cursor", labelKey: "mode.work" },
  { id: "chat", icon: "speech-bubble", labelKey: "mode.chat" },
] as const

const PILL_DURATION = 320

export function ModeToggle(props: { mode?: SessionMode; fixed?: boolean; onSelect?: (mode: SessionMode) => void }) {
  const settings = useSettings()
  const language = useLanguage()
  const state = createMemo(() => ({ mode: props.mode ?? settings.general.mode(), fixed: props.fixed === true }))
  const [buttons, setButtons] = createSignal<Partial<Record<SessionMode, HTMLButtonElement>>>({})
  let container: HTMLDivElement | undefined
  let indicator: HTMLDivElement | undefined
  let positioned = false
  let disposed = false
  // Keep the handle: an in-flight tween writes transform/width every frame, so a
  // discarded handle lets a previous switch's tween overwrite the styles written
  // below and settle the pill on the previous target.
  let pill: ReturnType<typeof animate> | undefined
  const pausePill = () => {
    if (!pill) return
    // Paused, not reverted: the pill keeps its current position, which the next
    // tween then animates from.
    pill.pause()
    pill = undefined
  }
  const revertPill = () => {
    if (!pill) return
    pill.revert()
    pill = undefined
  }

  const target = (mode: SessionMode) => {
    const button = buttons()[mode]
    if (button === undefined || indicator === undefined || container === undefined) return undefined
    const containerRect = container.getBoundingClientRect()
    const buttonRect = button.getBoundingClientRect()
    return { x: buttonRect.left - containerRect.left, width: buttonRect.width }
  }

  const sync = (animated: boolean): boolean => {
    const next = target(state().mode)
    if (next === undefined || indicator === undefined) return false
    // Never apply a collapsed pill: measuring while hidden (zero rects) would
    // leave the toggle background invisible with only bold text showing.
    if (next.width <= 0) return false
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (!animated || reduced || !positioned) {
      revertPill()
      indicator.style.opacity = "1"
      indicator.style.transform = `translateX(${next.x}px)`
      indicator.style.width = `${next.width}px`
      positioned = true
      return true
    }
    pausePill()
    indicator.style.opacity = "1"
    pill = animate(indicator, {
      translateX: next.x,
      width: next.width,
      duration: 420,
      ease: "outBack(1.6)",
    })
    positioned = true
    return true
  }

  let retryFrame: number | undefined
  let retryTimeout: number | undefined
  let observer: ResizeObserver | undefined
  const syncSoon = (animated: boolean) => {
    if (disposed) return
    if (retryFrame !== undefined) cancelAnimationFrame(retryFrame)
    if (retryTimeout !== undefined) clearTimeout(retryTimeout)
    if (sync(animated)) {
      retryFrame = undefined
      retryTimeout = undefined
      return
    }
    // Refs or layout are not ready yet (hidden mount, font swap, slide
    // animation holding zero rects); retry until visible instead of leaving
    // the pill invisible after ~10 frames.
    let attempts = 0
    const tick = () => {
      retryFrame = undefined
      if (disposed || sync(animated) || attempts >= 60) return
      attempts += 1
      retryFrame = requestAnimationFrame(tick)
    }
    retryFrame = requestAnimationFrame(tick)
    // Fallback for backgrounded tabs where rAF never fires.
    retryTimeout = window.setTimeout(() => {
      retryTimeout = undefined
      if (disposed || positioned) return
      sync(false)
    }, 500)
  }

  onMount(() => {
    syncSoon(false)
    observer = new ResizeObserver(() => syncSoon(false))
    if (container !== undefined) observer.observe(container)
    for (const button of Object.values(buttons())) observer.observe(button)
    const onFontsReady = () => syncSoon(false)
    if (typeof document !== "undefined" && document.fonts !== undefined) {
      document.fonts.ready.then(onFontsReady).catch(() => undefined)
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") syncSoon(false)
    }
    const onLoad = () => syncSoon(false)
    window.addEventListener("load", onLoad)
    document.addEventListener("visibilitychange", onVisible)
    onCleanup(() => {
      disposed = true
      observer?.disconnect()
      observer = undefined
      revertPill()
      container = undefined
      indicator = undefined
      setButtons({})
      window.removeEventListener("load", onLoad)
      document.removeEventListener("visibilitychange", onVisible)
      if (retryFrame !== undefined) cancelAnimationFrame(retryFrame)
      if (retryTimeout !== undefined) clearTimeout(retryTimeout)
    })
  })

  // Re-position (unanimated) whenever the buttons remount or labels change
  // width (locale switch), so the pill can never strand on stale geometry.
  // Also (re)observe buttons: the initial snapshot can be empty while
  // sliding/Suspense holds zero rects.
  createEffect(() => {
    const count = Object.keys(buttons()).length
    language.t("mode.work")
    language.t("mode.chat")
    if (count > 0) {
      if (observer !== undefined) {
        for (const button of Object.values(buttons())) observer.observe(button)
      }
      syncSoon(false)
    }
  })

  createEffect(
    on(
      () => state().mode,
      () => syncSoon(true),
      { defer: true },
    ),
  )

  return (
    <TooltipV2
      placement="bottom"
      inactive={!state().fixed}
      value={language.t("mode.session.fixed")}
      class="shrink-0"
    >
      <div
        ref={container}
        role="tablist"
        aria-label={language.t("mode.ariaLabel")}
        aria-disabled={state().fixed}
        class="relative flex h-7 shrink-0 items-center gap-0.5 rounded-md bg-surface-raised-base p-0.5"
      >
        <div
          ref={indicator}
          aria-hidden="true"
          class="pointer-events-none absolute top-0.5 bottom-0.5 left-0 rounded-[5px] bg-background-stronger opacity-0 shadow-sm"
        />
        <For each={MODES}>
          {(mode) => (
            <button
              ref={(element) => setButtons((current) => ({ ...current, [mode.id]: element }))}
              type="button"
              role="tab"
              disabled={state().fixed}
              aria-selected={state().mode === mode.id}
              class="relative z-10 flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-11-medium transition-colors"
              classList={{
                "text-text-strong": state().mode === mode.id,
                "text-text-weak hover:text-text-strong": state().mode !== mode.id,
                "disabled:cursor-default": state().fixed,
              }}
              onClick={() => {
                if (state().fixed) return
                if (props.onSelect !== undefined) props.onSelect(mode.id)
                else settings.general.setMode(mode.id)
              }}
            >
              <Icon name={mode.icon} size="small" />
              <span>{language.t(mode.labelKey)}</span>
            </button>
          )}
        </For>
      </div>
    </TooltipV2>
  )
}
