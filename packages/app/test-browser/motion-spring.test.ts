import { expect, test } from "bun:test"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { createRoot, createSignal } from "solid-js"

test("snaps spring progress when the session changes", async () => {
  const state = createRoot((dispose) => {
    const [target, setTarget] = createSignal(0)
    const [session, setSession] = createSignal("session-a")
    const progress = useSpring(target, { visualDuration: 0.3, bounce: 0 }, session)
    return { dispose, progress, setTarget, setSession }
  })

  await new Promise<void>(queueMicrotask)
  state.setTarget(1)
  expect(state.progress()).toBe(0)

  state.setSession("session-b")
  expect(state.progress()).toBe(1)
  state.dispose()
})

function stubMatchMedia(matches: boolean) {
  const listeners: (() => void)[] = []
  const media = {
    matches,
    addEventListener: (_type: string, listener: () => void) => {
      listeners.push(listener)
    },
    removeEventListener: (_type: string, listener: () => void) => {
      const index = listeners.indexOf(listener)
      if (index >= 0) listeners.splice(index, 1)
    },
  }
  // Sibling suites share this process and its happydom globals, so the
  // previous window is restored afterwards rather than deleted.
  const previous = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { matchMedia: () => media }
  return { listeners, media, restore: () => {
    ;(globalThis as { window?: unknown }).window = previous
  } }
}

function unstubMatchMedia(stub: { restore: () => void }) {
  stub.restore()
}

test("reduced motion snaps to the target instead of springing", async () => {
  const stub = stubMatchMedia(true)
  try {
    const state = createRoot((dispose) => {
      const [target, setTarget] = createSignal(0)
      const progress = useSpring(target, { visualDuration: 0.3, bounce: 0 })
      return { dispose, progress, setTarget }
    })

    await new Promise<void>(queueMicrotask)
    state.setTarget(1)
    expect(state.progress()).toBe(1)
    state.dispose()
  } finally {
    unstubMatchMedia(stub)
  }
})

test("a live reduced-motion change snaps a spring in flight", async () => {
  const stub = stubMatchMedia(false)
  try {
    const state = createRoot((dispose) => {
      const [target, setTarget] = createSignal(0)
      const progress = useSpring(target, { visualDuration: 0.3, bounce: 0 })
      return { dispose, progress, setTarget }
    })

    await new Promise<void>(queueMicrotask)
    state.setTarget(1)
    expect(state.progress()).toBe(0)
    stub.media.matches = true
    stub.listeners.forEach((listener) => listener())
    expect(state.progress()).toBe(1)
    state.dispose()
  } finally {
    unstubMatchMedia(stub)
  }
})
