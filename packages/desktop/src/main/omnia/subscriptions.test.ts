import { expect, test } from "bun:test"
import type { ComputerEvent } from "@opencode-ai/omnia/protocol"
import { createOmniaSubscriptions } from "./subscriptions"
import type { OmniaDriver, OmniaEvent } from "./types"

const firstId = "00000000-0000-4000-8000-000000000001"
const secondId = "00000000-0000-4000-8000-000000000002"

function createDriver(subscribe: OmniaDriver["subscribe"]): OmniaDriver {
  return {
    id: "native-test",
    backend: "accessibility",
    subscribe,
  }
}

test("subscriptions share one native stream and clean up after the final callback", async () => {
  let listener: ((event: ComputerEvent) => void) | undefined
  let nativeSubscriptions = 0
  let nativeUnsubscriptions = 0
  const published: OmniaEvent[] = []
  const driver = createDriver((next) => {
    nativeSubscriptions++
    listener = next
    return {
      ok: true,
      status: "ok",
      value: () => {
        nativeUnsubscriptions++
      },
    }
  })
  const subscriptions = createOmniaSubscriptions({
    getDriver: () => driver,
    publish: (_ownerId, _registeredDriver, event) => published.push(event),
  })

  expect((await subscriptions.subscribe(1, firstId)).status).toBe("ok")
  expect((await subscriptions.subscribe(1, secondId)).status).toBe("ok")
  expect(nativeSubscriptions).toBe(1)
  expect(subscriptions.count(1)).toBe(2)

  listener?.({
    id: "event-1",
    timestamp: 1,
    type: "computer.connected",
    computer: { id: "computer-1", name: "Desktop", platform: "linux" },
  })
  listener?.({
    id: "event-2",
    timestamp: 2,
    type: "computer.connected",
    computer: { id: "computer-1", name: "Desktop", platform: "linux" },
  })
  expect(published).toEqual([
    { id: "event-1", timestamp: 1, type: "computer.connected", computerId: undefined, code: undefined },
    { id: "event-2", timestamp: 2, type: "computer.connected", computerId: undefined, code: undefined },
  ])

  subscriptions.unsubscribe(1, firstId)
  expect(nativeUnsubscriptions).toBe(0)
  subscriptions.unsubscribe(1, secondId)
  subscriptions.unsubscribe(1, secondId)
  expect(nativeUnsubscriptions).toBe(1)
  expect(subscriptions.count(1)).toBe(0)
})

test("sender removal disconnects native events and pending subscriptions", async () => {
  let release: (() => void) | undefined
  let unsubscribed = false
  const driver = createDriver(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return {
      ok: true,
      status: "ok",
      value: () => {
        unsubscribed = true
      },
    }
  })
  const subscriptions = createOmniaSubscriptions({
    getDriver: () => driver,
    publish: () => undefined,
  })

  const pending = subscriptions.subscribe(1, firstId)
  subscriptions.removeOwner(1)
  release?.()
  expect((await pending).status).toBe("blocked")
  expect(unsubscribed).toBe(true)
  expect(subscriptions.count(1)).toBe(0)
})
