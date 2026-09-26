import { expect, test } from "bun:test"
import { createOmniaDriverRegistry } from "./registry"
import type { OmniaDriver } from "./types"

const driver: OmniaDriver = {
  id: "native-test",
  backend: "accessibility",
  observe: async () => ({ id: "observation-1", timestamp: 1, elements: [] }),
}

test("main-process registry holds one native driver and reports changes", () => {
  const registry = createOmniaDriverRegistry("linux")
  const changes: string[] = []
  const stop = registry.onChange(() => changes.push(registry.get()?.id ?? "none"))

  const unregister = registry.register(driver)
  expect(registry.get()).toBe(driver)
  expect(() => registry.register(driver)).toThrow("already registered")

  unregister()
  unregister()
  expect(registry.get()).toBeUndefined()
  expect(changes).toEqual(["native-test", "none"])
  stop()
})

test("main-process registry rejects malformed driver identities", () => {
  const registry = createOmniaDriverRegistry("linux")
  expect(() => registry.register({ ...driver, id: "../native" })).toThrow("driver id")
  expect(() => registry.register({ ...driver, backend: "native backend" })).toThrow("driver backend")
})

test("execute drivers cannot omit target revalidation", () => {
  const registry = createOmniaDriverRegistry("linux")
  expect(() =>
    registry.register({
      ...driver,
      execute: async () => ({ success: false, status: "rejected" }),
    }),
  ).toThrow("target revalidation")
})
