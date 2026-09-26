import { isComputerDriver } from "@opencode-ai/omnia/protocol"
import { isRecord } from "./validation"
import type { OmniaDriver } from "./types"

export type OmniaDriverRegistry = {
  readonly platform: string
  register: (driver: OmniaDriver) => () => void
  get: () => OmniaDriver | undefined
  onChange: (listener: () => void) => () => void
  clear: () => void
}

export function createOmniaDriverRegistry(platform: string): OmniaDriverRegistry {
  let current: OmniaDriver | undefined
  const listeners = new Set<() => void>()

  const notify = () => listeners.forEach((listener) => listener())

  return {
    platform,
    register(driver) {
      if (current) throw new Error("An Omnia driver is already registered")
      validateOmniaDriver(driver)
      current = driver
      notify()
      let registered = true
      return () => {
        if (!registered) return
        registered = false
        if (current !== driver) return
        current = undefined
        notify()
      }
    },
    get() {
      return current
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    clear() {
      if (!current) return
      current = undefined
      notify()
    },
  }
}

export const omniaDriverRegistry = createOmniaDriverRegistry(process.platform)

export function registerOmniaDriver(driver: OmniaDriver) {
  return omniaDriverRegistry.register(driver)
}

export function getOmniaDriver() {
  return omniaDriverRegistry.get()
}

export function validateOmniaDriver(driver: OmniaDriver) {
  if (!isComputerDriver(driver)) throw new TypeError("Invalid Omnia driver")
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(driver.id)) throw new TypeError("Invalid Omnia driver id")
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(driver.backend)) {
    throw new TypeError("Invalid Omnia driver backend")
  }
  if (!isRecord(driver)) throw new TypeError("Invalid Omnia driver")
  if (Boolean(driver.execute) !== Boolean(driver.revalidateTarget)) {
    throw new TypeError("Omnia execute drivers must support target revalidation")
  }
  if (driver.subscribe !== undefined && typeof driver.subscribe !== "function") {
    throw new TypeError("Invalid Omnia driver operation")
  }
  if (
    !driver.getInfo &&
    !driver.getEnvironment &&
    !driver.observe &&
    !driver.find &&
    !driver.execute &&
    !driver.subscribe
  ) {
    throw new TypeError("Omnia driver has no operations")
  }
}
