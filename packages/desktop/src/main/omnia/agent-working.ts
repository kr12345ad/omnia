import { write as writeLog } from "../logging"
import { createAgentState, type AgentActivityEvent, type AgentWorkingSnapshot } from "./agent-state"
import { createAgentOverlay } from "./overlay"
import { createAgentPower } from "./agent-power"
import { serverCall } from "./server-call"

// The listener contract of the server EventBus (EventBus.subscribe), narrowed
// to the fields the overlay reads, so a live server bus and the desktop's own
// runtime notifications are both valid sources.
type AgentEventSource = { subscribe(listener: (event: AgentActivityEvent) => void): () => void }

// A grab that outlives the app locks the whole machine, so freeze and release
// never wait out the control plane's multi-minute request deadline: the caller
// gives up after this and the queue moves on.
const INPUT_CALL_TIMEOUT_MS = 5000

export interface AgentWorking {
  setRendererWorking(sourceId: number, working: boolean): void
  notifyActionStart(): void
  notifyActionEnd(ok: boolean): void
  attach(events: AgentEventSource): void
  releaseNow(): void
  isWorking(): boolean
  destroy(): void
}

export interface AgentWorkingOptions {
  readonly computerId?: () => string | undefined
  readonly call?: (
    path: string,
    method: "GET" | "POST" | "DELETE",
    body?: unknown,
  ) => Promise<Record<string, unknown>>
}

export function createAgentWorking(options: AgentWorkingOptions = {}): AgentWorking {
  const overlay = createAgentOverlay()
  const power = createAgentPower()
  let unsubscribe: (() => void) | undefined
  let frozen = false
  // The server can hold a grab even when the freeze request failed, so a
  // release stays owed until one is confirmed.
  let grabbed = false
  let releasing = false
  let quitting = false
  // Freeze/release calls are serialized so a fast native -> idle -> native
  // transition can never deliver a release before its freeze. Only the newest
  // unsent action survives: a freeze the user already walked away from would
  // hold input after the release that superseded it.
  let queued: "freeze" | "release" | undefined
  let queue: Promise<unknown> = Promise.resolve()

  // The server requires an explicit computer id for freeze/release; without it
  // the request 400s and the halo would paint with no input lock behind it.
  const send = async (action: "freeze" | "release") => {
    const computerId = options.computerId?.()
    const request = (options.call ?? serverCall)(`/v1/input/${action}`, "POST", {
      ...(computerId === undefined ? {} : { computerId }),
      ...(action === "freeze" ? { reason: "agent task" } : {}),
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // The deadline is local: the control-plane client owns its own abort
      // signal, and losing the race only abandons this attempt.
      await Promise.race([
        request,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`The control plane did not ${action} agent input in time.`)),
            INPUT_CALL_TIMEOUT_MS,
          ),
          timer.unref?.()
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  const post = async (action: "freeze" | "release") => {
    if (action === "freeze") grabbed = true
    try {
      await send(action)
      writeLog("agent", action === "freeze" ? "agent input frozen" : "agent input released")
      if (action === "release") {
        grabbed = false
        return
      }
      // A freeze that settles after the quit-time release re-grabs the machine
      // with the client gone, so the release is repeated here. It goes out even
      // when another one is still in flight: that one was issued before this
      // freeze completed, so the server may already have applied it.
      if (!quitting) return
      await post("release")
    } catch (error: unknown) {
      // A failed freeze must not leave the client believing input is frozen:
      // clearing the flag makes the next transition retry it. Every failure is
      // logged, because a grab that never releases is the one failure the
      // user can neither see nor work around.
      if (action === "freeze") frozen = false
      writeLog("agent", `failed to ${action} agent input`, { error: String(error) }, "warn")
    }
  }

  const drain = async () => {
    while (queued !== undefined) {
      const action = queued
      queued = undefined
      await post(action)
    }
  }

  const enqueue = (action: "freeze" | "release") => {
    // A freeze is only worth sending when nothing else is owed: it would grab
    // input either for a run the user already walked away from or behind a
    // release their Escape had already claimed, and in both cases the machine
    // ends up locked with nothing left to release it.
    if (action === "freeze" && (quitting || queued !== undefined)) return
    queued = action
    // Both arms run the drain so a single bad call can never wedge the queue.
    queue = queue.then(drain, drain)
  }

  const setFrozen = (active: boolean) => {
    // A quit in progress outranks the snapshot: the release has been sent (or
    // is owed), so no freeze may follow it and none may be claimed locally.
    const next = active && !quitting
    if (next === frozen) return
    frozen = next
    enqueue(next ? "freeze" : "release")
  }

  const apply = (snapshot: AgentWorkingSnapshot) => {
    // The ring is reserved for real computer use: native actions (clicks,
    // typing, scrolling, screenshots) show it; model thinking does not.
    if (snapshot.nativeComputerUse) {
      overlay.showWorking()
    } else {
      overlay.hideWorking()
    }
    if (snapshot.working) power.preventSleep()
    else power.allowSleep()
    setFrozen(snapshot.working && snapshot.nativeComputerUse && !snapshot.suppressed)
  }

  const state = createAgentState({ onChange: apply })

  // Quit, relaunch and updater paths call this directly, because none of them
  // can wait behind the queue: a freeze on it may be hung on the control plane
  // for its full multi-minute deadline, and the grab outlives the process. The
  // freeze it may be racing is answered again from `post` once it settles.
  const releaseNow = () => {
    quitting = true
    frozen = false
    queued = undefined
    if (!grabbed || releasing) return
    releasing = true
    // Fire and forget: a quit may not survive the wait, and a release that
    // fails leaves the grab owed so the next quit hook tries again.
    void post("release").finally(() => {
      releasing = false
    })
  }

  return {
    setRendererWorking(sourceId, working) {
      state.setRendererWorking(sourceId, working)
    },
    notifyActionStart() {
      state.recordEvent({ type: "action.started" })
    },
    notifyActionEnd(ok: boolean) {
      state.recordEvent({ type: ok ? "action.completed" : "action.failed" })
    },
    attach(events) {
      unsubscribe?.()
      unsubscribe = events.subscribe((event: AgentActivityEvent) => {
        // Grab notifications the runtime emits in response to this client's own
        // freeze or release are not agent activity. Counting them would extend
        // the working window, so an idle release would be followed by an
        // immediate re-freeze with nothing left to do.
        if (event.type === "input.frozen") return
        if (event.type === "input.released" && event.data?.releasedBy !== "escape") return
        if (event.type === "input.released") {
          // The user pressed Escape twice and the server already released the
          // grab. Reconcile local state so the next transition cannot leak a
          // stale freeze; the queued release is a safe no-op server-side.
          writeLog("agent", "agent input released by user")
          setFrozen(false)
        }
        state.recordEvent(event)
      })
    },
    releaseNow,
    isWorking: () => state.snapshot().working,
    destroy() {
      unsubscribe?.()
      unsubscribe = undefined
      releaseNow()
      state.dispose()
      power.destroy()
      overlay.destroy()
    },
  }
}