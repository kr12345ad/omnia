import { expect, test } from "bun:test"
import { createAgentState, type AgentWorkingSnapshot } from "./agent-state"

test("activity raises working until the activity window expires", async () => {
  const changes: AgentWorkingSnapshot[] = []
  const state = createAgentState({
    activityWindowMs: 30,
    nativeWindowMs: 60,
    onChange: (snapshot) => changes.push(snapshot),
  })

  state.recordEvent({ type: "observation.created" })
  expect(state.snapshot().working).toBe(true)
  expect(state.snapshot().nativeComputerUse).toBe(false)

  await Bun.sleep(60)
  expect(state.snapshot().working).toBe(false)
  expect(changes.at(-1)).toEqual({ working: false, nativeComputerUse: false, suppressed: false })
  state.dispose()
})

test("native computer use ignores browser actions", () => {
  const state = createAgentState({ activityWindowMs: 1000, nativeWindowMs: 1000 })

  state.recordEvent({ type: "browser.action" })
  expect(state.snapshot().working).toBe(true)
  expect(state.snapshot().nativeComputerUse).toBe(false)

  state.recordEvent({ type: "action.completed" })
  expect(state.snapshot().nativeComputerUse).toBe(true)
  expect(state.snapshot().working).toBe(true)

  state.recordEvent({ type: "computer_use.executed" })
  expect(state.snapshot().nativeComputerUse).toBe(true)
  state.dispose()
})

test("renderer working state keeps the agent working until every renderer clears", async () => {
  const state = createAgentState({ activityWindowMs: 20, nativeWindowMs: 20 })

  state.setRendererWorking(1, true)
  state.setRendererWorking(2, true)
  await Bun.sleep(40)
  expect(state.snapshot().working).toBe(true)

  state.setRendererWorking(1, false)
  expect(state.snapshot().working).toBe(true)

  state.setRendererWorking(2, false)
  expect(state.snapshot().working).toBe(false)
  state.dispose()
})

test("escape release suppresses re-freezing until the next native action", async () => {
  const state = createAgentState({ activityWindowMs: 30, nativeWindowMs: 120 })

  state.recordEvent({ type: "action.started" })
  expect(state.snapshot().nativeComputerUse).toBe(true)
  expect(state.snapshot().suppressed).toBe(false)

  state.recordEvent({ type: "input.released", data: { releasedBy: "escape" } })
  expect(state.snapshot().suppressed).toBe(true)

  // Neither non-native activity nor an idle refresh may hand input back: the
  // native window is still open, so an in-run event would grab the machine
  // again and undo the user's Escape.
  state.recordEvent({ type: "observation.created" })
  expect(state.snapshot().suppressed).toBe(true)

  await Bun.sleep(60)
  expect(state.snapshot().working).toBe(false)
  expect(state.snapshot().suppressed).toBe(true)

  state.recordEvent({ type: "action.started" })
  expect(state.snapshot().nativeComputerUse).toBe(true)
  expect(state.snapshot().suppressed).toBe(false)
  state.dispose()
})

test("renderer working keeps the snapshot fresh and dispose is terminal", async () => {
  const changes: AgentWorkingSnapshot[] = []
  let at = 0
  const state = createAgentState({
    now: () => at,
    activityWindowMs: 5,
    nativeWindowMs: 5,
    recheckMs: 5,
    onChange: (snapshot) => changes.push(snapshot),
  })

  state.recordEvent({ type: "action.started" })
  state.setRendererWorking(1, true)
  expect(state.snapshot().working).toBe(true)
  expect(state.snapshot().nativeComputerUse).toBe(true)

  // Both window expiries are in the past now: the renderer still reports
  // working, and the periodic re-check keeps recomputing the snapshot instead
  // of leaving a stale one with no timer behind it.
  at = 1000
  await Bun.sleep(60)
  expect(state.snapshot().nativeComputerUse).toBe(false)
  expect(state.snapshot().working).toBe(true)

  state.dispose()
  changes.length = 0
  state.recordEvent({ type: "action.started" })
  state.setRendererWorking(1, false)
  expect(changes).toEqual([])
  expect(state.snapshot().working).toBe(true)
})

test("input releases without the escape payload do not suppress", () => {
  const state = createAgentState({ activityWindowMs: 1000, nativeWindowMs: 1000 })

  state.recordEvent({ type: "action.started" })
  state.recordEvent({ type: "input.released", data: { releasedBy: "server" } })
  expect(state.snapshot().suppressed).toBe(false)
  state.dispose()
})
