import { describe, expect, test } from "bun:test"
import { EventBus } from "./events"
import type { ServerComputerDriver } from "./computers"
import {
  parseRemotePublicKey,
  REMOTE_MAX_COMMAND_MS,
  REMOTE_STALE_MS,
  RemoteComputerDriver,
  RemotePollLimitError,
  RemoteRegistry,
} from "./remote"
import { createRemoteKeyPair } from "../remote/keys"
import type { ComputerAction } from "../protocol"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const click: ComputerAction = { type: "click", x: 10, y: 20 }
const success = { success: true, status: "success" } as const

function createRegistry(overrides: {
  now: () => number
  staleMs?: number
  randomComputerId?: () => string
  onUnregister?: (driver: ServerComputerDriver) => void
}): RemoteRegistry {
  let issued = 0
  return new RemoteRegistry({
    events: new EventBus({ serverId: "test" }),
    registerDriver: (driver) => () => {
      overrides.onUnregister?.(driver)
    },
    now: overrides.now,
    staleMs: overrides.staleMs ?? 1000,
    reapIntervalMs: 5,
    randomToken: () => `token-${(issued += 1)}`,
    ...(overrides.randomComputerId === undefined ? {} : { randomComputerId: overrides.randomComputerId }),
  })
}

function driver(overrides: { now?: () => number; timeouts?: Record<string, number> } = {}): RemoteComputerDriver {
  return new RemoteComputerDriver({
    id: "remote-1",
    name: "Remote",
    platform: "linux",
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.timeouts === undefined ? {} : { timeouts: overrides.timeouts }),
  })
}

describe("remote command lifecycle", () => {
  test("a timed-out command leaves the queue so it cannot run later, out of order", async () => {
    const instance = driver({ timeouts: { execute: 20 } })
    const clickPromise = instance.execute(click)
    const writePromise = instance.writeClipboard("hello")
    await expect(clickPromise).rejects.toThrow("did not answer execute in time")
    // The click timed out while still queued, so only the clipboard write is left.
    const delivered = await instance.nextCommand(50)
    expect(delivered).toMatchObject({ method: "writeClipboard", params: { text: "hello" } })
    instance.complete({ id: delivered!.id, ok: true, result: success })
    expect(await writePromise).toMatchObject(success)
    // Nothing is left to run: the abandoned click never reaches the machine.
    expect(await instance.nextCommand(20)).toBeUndefined()
  })

  test("a timeout releases the in-flight slot so a hung command cannot pin a computer", async () => {
    const instance = driver({ timeouts: { execute: 20 } })
    const pending = instance.execute(click).then(
      () => undefined,
      (error: unknown) => error as Error,
    )
    expect(instance.inFlightCount).toBe(0)
    expect((await instance.nextCommand(50))?.method).toBe("execute")
    expect(instance.inFlightCount).toBe(1)
    await expect(pending).resolves.toThrow("did not answer execute in time")
    expect(instance.inFlightCount).toBe(0)
  })

  test("complete() only counts an accepted id as a heartbeat", async () => {
    let clock = 1_000_000
    const instance = driver({ now: () => clock })
    clock += 5_000
    expect(instance.complete({ id: "not-a-command", ok: true })).toBe(false)
    expect(instance.lastSeenAt).toBe(1_000_000)
    const pending = instance.execute(click)
    const command = await instance.nextCommand(50)
    clock += 5_000
    expect(instance.complete({ id: command!.id, ok: true, result: success })).toBe(true)
    expect(instance.lastSeenAt).toBe(1_010_000)
    await pending
    expect(instance.complete({ id: command!.id, ok: true })).toBe(false)
    expect(instance.lastSeenAt).toBe(1_010_000)
  })

  test("caps concurrent command polls instead of parking them without limit", async () => {
    const instance = driver()
    const parked = Array.from({ length: 8 }, () => instance.nextCommand(1_000))
    await expect(instance.nextCommand(50)).rejects.toBeInstanceOf(RemotePollLimitError)
    await expect(instance.nextCommand(50)).rejects.toMatchObject({ status: 429 })
    instance.dispose()
    await Promise.all(parked)
    // The cap only bounds parked polls; the driver still accepts work again.
    expect(await instance.nextCommand(20)).toBeUndefined()
  })

  test("the stale window outlives the slowest command", () => {
    expect(REMOTE_MAX_COMMAND_MS).toBe(300000)
    expect(REMOTE_STALE_MS).toBeGreaterThan(REMOTE_MAX_COMMAND_MS)
  })

  test("dispose rejects pending calls, drops queued commands, and wakes waiters", async () => {
    const instance = driver({ timeouts: { execute: 60_000 } })
    const parked = instance.nextCommand(1_000)
    const delivered = instance.execute(click).catch((error: unknown) => error as Error)
    const stranded = instance.writeClipboard("hello").catch((error: unknown) => error as Error)
    instance.dispose()
    expect((await delivered).message).toContain("was disconnected")
    expect((await stranded).message).toContain("was disconnected")
    expect(await parked).toMatchObject({ method: "execute" })
    // The queue went with the driver, so the next poll finds nothing to run.
    expect(await instance.nextCommand(20)).toBeUndefined()
  })
})

describe("remote reaping", () => {
  test("keeps a computer with a command in flight and reaps it once it goes idle", async () => {
    let clock = 1_000_000
    const disposed: string[] = []
    const registry = createRegistry({
      now: () => clock,
      randomComputerId: () => "remote-reap0001",
      onUnregister: (registered) => disposed.push(registered.id),
    })
    const claim = registry.claim({ name: "Reap", platform: "linux" })
    const pending = claim.driver.execute(click)
    const command = await registry.next(claim.computerId, 50)
    expect(command?.method).toBe("execute")
    expect(claim.driver.inFlightCount).toBe(1)

    // Silent far past the stale window with a command still running: reaping
    // here would dispose the driver, 404 the agent's result POST, and stop it
    // from polling ever again.
    clock += 60_000
    await sleep(40)
    expect(registry.ids()).toEqual([claim.computerId])
    expect(disposed).toEqual([])

    registry.complete(claim.computerId, { id: command!.id, ok: true, result: success })
    await pending
    expect(claim.driver.inFlightCount).toBe(0)
    clock += 60_000
    await sleep(40)
    expect(registry.ids()).toEqual([])
    expect(disposed).toEqual(["remote-reap0001"])
    registry.close()
  })

  test("a silent idle computer is reaped", async () => {
    let clock = 1_000_000
    const registry = createRegistry({ now: () => clock })
    registry.claim({ name: "Silent", platform: "linux" })
    expect(registry.ids()).toHaveLength(1)
    await sleep(30)
    expect(registry.ids()).toHaveLength(1)
    clock += 10_000
    await sleep(30)
    expect(registry.ids()).toEqual([])
    registry.close()
  })
})

describe("remote claim key policy", () => {
  test("reusing a keyed computer id requires that same key", () => {
    const registry = createRegistry({ now: () => 1_000_000 })
    const owned = createRemoteKeyPair()
    const impostor = createRemoteKeyPair()
    const first = registry.claim({
      name: "Owned",
      platform: "linux",
      publicKey: parseRemotePublicKey(owned.publicKey)!,
      reuseId: "remote-0000000a",
    })
    expect(first.computerId).toBe("remote-0000000a")

    // No key at all: the keyed entry survives and a fresh id is issued.
    const unsigned = registry.claim({ name: "Thief", platform: "linux", reuseId: "remote-0000000a" })
    expect(unsigned.computerId).not.toBe("remote-0000000a")
    expect(registry.authorize("remote-0000000a", unsigned.token)).toBe(false)
    expect(registry.authorize(unsigned.computerId, unsigned.token)).toBe(true)

    // A different key must not take the id over either.
    const otherKey = registry.claim({
      name: "Impostor",
      platform: "linux",
      publicKey: parseRemotePublicKey(impostor.publicKey)!,
      reuseId: "remote-0000000a",
    })
    expect(otherKey.computerId).not.toBe("remote-0000000a")
    expect(registry.authorize("remote-0000000a", otherKey.token)).toBe(false)

    // The original key still owns the id, and re-registering rotates its token.
    const sameKey = registry.claim({
      name: "Owned",
      platform: "linux",
      publicKey: parseRemotePublicKey(owned.publicKey)!,
      reuseId: "remote-0000000a",
    })
    expect(sameKey.computerId).toBe("remote-0000000a")
    expect(registry.authorize("remote-0000000a", first.token)).toBe(false)
    expect(registry.authorize("remote-0000000a", sameKey.token)).toBe(true)
    registry.close()
  })

  test("an unkeyed entry stays replaceable during migration", () => {
    const registry = createRegistry({ now: () => 1_000_000 })
    const first = registry.claim({ name: "Legacy", platform: "linux" })
    const second = registry.claim({ name: "Legacy", platform: "linux", reuseId: first.computerId })
    expect(second.computerId).toBe(first.computerId)
    registry.close()
  })
})