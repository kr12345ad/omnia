export type AgentWorkingSnapshot = {
  readonly working: boolean
  readonly nativeComputerUse: boolean
  readonly suppressed: boolean
}

export type AgentActivityEvent = {
  readonly type: string
  readonly data?: Readonly<Record<string, unknown>>
}

export type AgentStateOptions = {
  readonly now?: () => number
  readonly activityWindowMs?: number
  readonly nativeWindowMs?: number
  readonly recheckMs?: number
  readonly onChange?: (snapshot: AgentWorkingSnapshot) => void
}

export interface AgentState {
  snapshot(): AgentWorkingSnapshot
  recordEvent(event: AgentActivityEvent): void
  setRendererWorking(sourceId: number, working: boolean): void
  subscribe(listener: (snapshot: AgentWorkingSnapshot) => void): () => void
  dispose(): void
}

const ACTIVITY_WINDOW_MS = 2500
const NATIVE_WINDOW_MS = 5000
// Renderers can report working indefinitely, so the snapshot needs a periodic
// re-check armed even when no window expiry is left.
const RECHECK_MS = 1000

const ACTIVITY_TYPES = new Set([
  "action.requested",
  "action.started",
  "action.completed",
  "action.failed",
  "action.verified",
  "browser.action",
  "observation.created",
  "computer_use.ready",
  "computer_use.model",
  "computer_use.routed",
  "computer_use.analyzed",
  "computer_use.executed",
  "computer_use.settings",
  "session.attached",
  "permission.requested",
  "input.frozen",
  "input.released",
])

// Native (non-browser) computer use, which needs the user's input frozen.
const NATIVE_TYPES = new Set([
  "action.requested",
  "action.started",
  "action.completed",
  "action.failed",
  "action.verified",
  "computer_use.executed",
])

const EMPTY: AgentWorkingSnapshot = { working: false, nativeComputerUse: false, suppressed: false }

export function createAgentState(options: AgentStateOptions = {}): AgentState {
  const now = options.now ?? Date.now
  const activityWindowMs = options.activityWindowMs ?? ACTIVITY_WINDOW_MS
  const nativeWindowMs = options.nativeWindowMs ?? NATIVE_WINDOW_MS
  const recheckMs = options.recheckMs ?? RECHECK_MS
  const listeners = new Set<(snapshot: AgentWorkingSnapshot) => void>()
  const rendererWorking = new Set<number>()
  let lastActivityAt = Number.NEGATIVE_INFINITY
  let lastNativeAt = Number.NEGATIVE_INFINITY
  let suppressed = false
  let current = EMPTY
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearTimer = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  const nextExpiry = (at: number) => {
    const expiries: number[] = []
    if (rendererWorking.size === 0) expiries.push(lastActivityAt + activityWindowMs)
    expiries.push(lastNativeAt + nativeWindowMs)
    const future = expiries.filter((value) => value > at)
    // While a renderer still reports working there may be no expiry left at
    // all, and then no timer would be armed and `working` would stick true.
    if (rendererWorking.size > 0) return Math.min(...future, at + recheckMs)
    if (future.length === 0) return undefined
    return Math.min(...future)
  }

  const refresh = () => {
    const at = now()
    const working = rendererWorking.size > 0 || at - lastActivityAt < activityWindowMs
    const nativeComputerUse = at - lastNativeAt < nativeWindowMs
    const next: AgentWorkingSnapshot = { working, nativeComputerUse, suppressed }
    const changed =
      next.working !== current.working ||
      next.nativeComputerUse !== current.nativeComputerUse ||
      next.suppressed !== current.suppressed
    current = next

    clearTimer()
    const expiry = nextExpiry(at)
    if (expiry !== undefined) {
      timer = setTimeout(refresh, Math.max(0, expiry - at))
      timer.unref()
    }

    if (!changed) return
    options.onChange?.(current)
    listeners.forEach((listener) => listener(current))
  }

  const isActivity = (type: string) => ACTIVITY_TYPES.has(type) || type.startsWith("computer_use.")

  return {
    snapshot: () => current,
    recordEvent(event) {
      if (disposed || !isActivity(event.type)) return
      const at = now()
      lastActivityAt = at
      if (NATIVE_TYPES.has(event.type)) {
        lastNativeAt = at
        // The user keeps input until the agent starts a new native action.
        // Clearing this on an idle refresh instead would hand input back to
        // the agent while the native window is still open, and the next event
        // of the same run would grab the machine again.
        suppressed = false
      }
      if (event.type === "input.released" && event.data?.releasedBy === "escape") suppressed = true
      refresh()
    },
    setRendererWorking(sourceId, working) {
      if (disposed) return
      if (working) rendererWorking.add(sourceId)
      else rendererWorking.delete(sourceId)
      refresh()
    },
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      disposed = true
      clearTimer()
      listeners.clear()
      rendererWorking.clear()
    },
  }
}
