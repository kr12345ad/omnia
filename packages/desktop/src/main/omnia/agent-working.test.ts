import { expect, mock, test } from "bun:test"

import type { AgentActivityEvent } from "./agent-state"

// The overlay only paints a window, and power management talks to dbus and (on
// Linux) the X server. Both are stubbed here so a unit test of the freeze
// lifecycle never touches a display, and the logger is stubbed so importing
// `../logging` does not drag Electron into this file.
const logged: string[] = []
mock.module("../logging", () => ({
  write: (_name: string, message: string) => {
    logged.push(message)
  },
}))
mock.module("./overlay", () => ({
  createAgentOverlay: () => ({
    showWorking: () => undefined,
    hideWorking: () => undefined,
    isVisible: () => false,
    destroy: () => undefined,
  }),
}))
mock.module("./agent-power", () => ({
  createAgentPower: () => ({
    preventSleep: () => undefined,
    allowSleep: () => undefined,
    destroy: () => undefined,
  }),
}))
mock.module("./server-call", () => ({
  // Every scenario injects its own `call`, so reaching this is a bug.
  serverCall: () => Promise.reject(new Error("serverCall must be injected in this test")),
}))

const { createAgentWorking } = await import("./agent-working")
type AgentWorking = ReturnType<typeof createAgentWorking>

const settle = () => Bun.sleep(5)

function events() {
  const listeners = new Set<(event: AgentActivityEvent) => void>()
  return {
    attach(working: AgentWorking) {
      working.attach({
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      })
    },
    emit(event: AgentActivityEvent) {
      for (const listener of listeners) listener(event)
    },
  }
}

test("the quit path releases the grab even mid-freeze", async () => {
  const calls: string[] = []
  // The freeze never settles during the test: the release must not wait for it.
  let settleFreeze: () => void = () => undefined
  const working = createAgentWorking({
    computerId: () => "computer-1",
    call: (path) => {
      calls.push(path)
      if (!path.endsWith("/freeze")) return Promise.resolve({ ok: true })
      return new Promise((resolve) => {
        settleFreeze = () => resolve({ ok: true })
      })
    },
  })
  const source = events()
  source.attach(working)

  working.notifyActionStart()
  await settle()
  expect(calls).toEqual(["/v1/input/freeze"])

  // before-quit calls releaseNow() while the freeze is still on the wire. The
  // release must not queue behind it, and a second call must not repeat a
  // release that already landed.
  working.releaseNow()
  await settle()
  expect(calls).toEqual(["/v1/input/freeze", "/v1/input/release"])
  working.releaseNow()
  await settle()
  expect(calls).toEqual(["/v1/input/freeze", "/v1/input/release"])

  // will-quit calls destroy(), which releases too; nothing is left owed.
  working.destroy()
  await settle()
  expect(calls).toEqual(["/v1/input/freeze", "/v1/input/release"])

  // A freeze that lands after the quit-time release re-grabs the machine with
  // the client gone, so it is answered with one more release.
  settleFreeze()
  await settle()
  expect(calls).toEqual(["/v1/input/freeze", "/v1/input/release", "/v1/input/release"])
})

test("a failed freeze retries on the next transition and is logged every time", async () => {
  const calls: string[] = []
  logged.length = 0
  const working = createAgentWorking({
    computerId: () => "computer-1",
    call: (path) => {
      calls.push(path)
      if (!path.endsWith("/freeze")) return Promise.resolve({ ok: true })
      return Promise.reject(new Error("control plane unreachable"))
    },
  })

  working.notifyActionStart()
  await settle()
  expect(calls).toEqual(["/v1/input/freeze"])

  // The failed freeze must not leave the client believing input is frozen: the
  // next native run freezes again instead of silently driving the machine with
  // input the agent does not hold.
  await Bun.sleep(2600)
  working.notifyActionStart()
  await settle()
  expect(calls).toEqual(["/v1/input/freeze", "/v1/input/freeze"])
  // A grab that never releases is invisible to the user, so the second failure
  // is logged just like the first.
  expect(logged.filter((message) => message === "failed to freeze agent input").length).toBe(2)

  // A failed freeze may still have reached the server, so the grab stays owed
  // and teardown releases it.
  working.destroy()
  await settle()
  expect(calls).toEqual(["/v1/input/freeze", "/v1/input/freeze", "/v1/input/release"])
})

test("a queued release collapses the freeze behind it", async () => {
  const calls: string[] = []
  let settleFreeze: () => void = () => undefined
  const working = createAgentWorking({
    computerId: () => "computer-1",
    call: (path) => {
      calls.push(path)
      if (!path.endsWith("/freeze")) return Promise.resolve({ ok: true })
      return new Promise((resolve) => {
        settleFreeze = () => resolve({ ok: true })
      })
    },
  })
  const source = events()
  source.attach(working)

  // The first freeze is in flight, so the queue is busy and everything after it
  // only collapses into the single pending slot.
  working.notifyActionStart()
  await settle()
  expect(calls).toEqual(["/v1/input/freeze"])

  // The user takes input back with Escape: a release is queued behind the
  // in-flight freeze.
  source.emit({ type: "input.released", data: { releasedBy: "escape" } })
  await settle()
  // The next native action is a new run and may freeze again, but it must not
  // jump the queued release: that would grab input after the user released it.
  working.notifyActionStart()
  await settle()
  expect(calls).toEqual(["/v1/input/freeze"])

  settleFreeze()
  await settle()
  expect(calls).toEqual(["/v1/input/freeze", "/v1/input/release"])
  working.destroy()
})

test("a queued freeze is dropped when a release follows it", async () => {
  const calls: string[] = []
  let settleRelease: () => void = () => undefined
  const working = createAgentWorking({
    computerId: () => "computer-1",
    call: (path) => {
      calls.push(path)
      if (!path.endsWith("/release")) return Promise.resolve({ ok: true })
      return new Promise((resolve) => {
        settleRelease = () => resolve({ ok: true })
      })
    },
  })
  const source = events()
  source.attach(working)

  working.notifyActionStart()
  await settle()
  expect(calls).toEqual(["/v1/input/freeze"])

  // Idle hands the grab back; that release is now in flight and blocks the
  // queue, so the next native run's freeze only sits in the pending slot.
  source.emit({ type: "input.released", data: { releasedBy: "escape" } })
  await settle()
  working.notifyActionStart()
  await settle()
  source.emit({ type: "input.released", data: { releasedBy: "escape" } })
  await settle()

  settleRelease()
  await settle()
  // Only the second release went out: the freeze that was still waiting in the
  // queue was superseded and never grabbed the machine.
  expect(calls).toEqual(["/v1/input/freeze", "/v1/input/release", "/v1/input/release"])
  working.destroy()
})

test("escape releases reconcile the local freeze and hold it until the next native action", async () => {
  const calls: string[] = []
  const working = createAgentWorking({
    computerId: () => "computer-1",
    call: (path) => {
      calls.push(path)
      return Promise.resolve({ ok: true })
    },
  })
  const source = events()
  source.attach(working)

  working.notifyActionStart()
  await settle()
  expect(calls).toEqual(["/v1/input/freeze"])

  // The runtime's own grab confirmation is not agent activity: counting it
  // would extend the working window and freeze again with nothing left to do.
  source.emit({ type: "input.frozen" })
  await settle()
  expect(calls).toEqual(["/v1/input/freeze"])

  // A server-driven release that the user did not ask for is not an escape.
  source.emit({ type: "input.released", data: { releasedBy: "server" } })
  await settle()
  expect(calls).toEqual(["/v1/input/freeze"])

  source.emit({ type: "input.released", data: { releasedBy: "escape" } })
  await settle()
  expect(calls).toEqual(["/v1/input/freeze", "/v1/input/release"])
  expect(working.isWorking()).toBe(true)

  // The native window is still open, so non-native activity must not re-grab.
  source.emit({ type: "observation.created" })
  await settle()
  expect(calls).toEqual(["/v1/input/freeze", "/v1/input/release"])

  // The next native action is a new run, so the agent may freeze again.
  working.notifyActionStart()
  await settle()
  expect(calls).toEqual(["/v1/input/freeze", "/v1/input/release", "/v1/input/freeze"])
  working.destroy()
})