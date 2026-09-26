import { isOmniaFailure } from "./operations"
import { parseOmniaEvent, parseOmniaSubscriptionId } from "./validation"
import {
  OMNIA_BLOCKED_REASONS,
  OMNIA_UNAVAILABLE_REASONS,
  type OmniaDriver,
  type OmniaEvent,
  type OmniaResult,
  type OmniaSubscribeIpcResult,
} from "./types"

export const OMNIA_MAX_SUBSCRIPTIONS_PER_SENDER = 8

type SubscriptionState = {
  ownerId: number
  driver: OmniaDriver
  subscriptionIds: Set<string>
  active: boolean
  unsubscribe?: () => void
  pending?: Promise<OmniaResult<void>>
}

export function createOmniaSubscriptions(input: {
  getDriver: () => OmniaDriver | undefined
  publish: (ownerId: number, driver: OmniaDriver, event: OmniaEvent) => void
  maxSubscriptionsPerOwner?: number
}) {
  const states = new Map<number, SubscriptionState>()
  const limit = input.maxSubscriptionsPerOwner ?? OMNIA_MAX_SUBSCRIPTIONS_PER_SENDER

  const remove = (state: SubscriptionState) => {
    if (!state.active) return
    state.active = false
    state.subscriptionIds.clear()
    const unsubscribe = state.unsubscribe
    state.unsubscribe = undefined
    if (states.get(state.ownerId) === state) states.delete(state.ownerId)
    try {
      unsubscribe?.()
    } catch {
      return
    }
  }

  const publish = (state: SubscriptionState, value: unknown) => {
    if (!state.active || state.subscriptionIds.size === 0) return
    const event = parseOmniaEvent(value)
    if (!event) return
    try {
      input.publish(state.ownerId, state.driver, event)
    } catch {
      remove(state)
    }
  }

  const connect = async (state: SubscriptionState): Promise<OmniaResult<void>> => {
    let value: unknown
    try {
      value = await state.driver.subscribe!((event) => publish(state, event))
    } catch {
      return blocked("operation_failed")
    }
    const failure = isOmniaFailure(value) ? value : undefined
    if (failure) return failure
    if (!isSubscribeSuccess(value)) return blocked("invalid_result")
    if (!state.active || state.subscriptionIds.size === 0 || input.getDriver() !== state.driver) {
      try {
        value.value()
      } catch {
        return blocked("sender_rejected")
      }
      return blocked("sender_rejected")
    }
    state.unsubscribe = value.value
    return { ok: true, status: "ok", value: undefined }
  }

  return {
    async subscribe(ownerId: number, subscriptionIdValue: unknown): Promise<OmniaSubscribeIpcResult> {
      if (!Number.isSafeInteger(ownerId) || ownerId < 1) return blocked("invalid_payload")
      let subscriptionId: string
      try {
        subscriptionId = parseOmniaSubscriptionId(subscriptionIdValue)
      } catch {
        return blocked("invalid_payload")
      }
      const driver = input.getDriver()
      if (!driver) return unavailable("driver_unavailable")
      if (!driver.subscribe) return unavailable("operation_unavailable")
      const existing = states.get(ownerId)
      if (existing?.driver !== driver) {
        if (existing) remove(existing)
        states.set(ownerId, {
          ownerId,
          driver,
          subscriptionIds: new Set(),
          active: true,
        })
      }
      const state = states.get(ownerId)!
      if (state.subscriptionIds.has(subscriptionId)) {
        return { ok: true, status: "ok", value: { subscriptionId } }
      }
      if (state.subscriptionIds.size >= limit) return blocked("subscription_limit")
      state.subscriptionIds.add(subscriptionId)
      if (state.unsubscribe) return { ok: true, status: "ok", value: { subscriptionId } }
      const result = state.pending ?? connect(state)
      state.pending = result
      try {
        const connected = await result
        if (connected.status !== "ok") {
          remove(state)
          return connected
        }
        return { ok: true, status: "ok", value: { subscriptionId } }
      } finally {
        if (state.pending === result) state.pending = undefined
      }
    },
    unsubscribe(ownerId: number, subscriptionIdValue: unknown) {
      let subscriptionId: string
      try {
        subscriptionId = parseOmniaSubscriptionId(subscriptionIdValue)
      } catch {
        return
      }
      const state = states.get(ownerId)
      if (!state?.subscriptionIds.delete(subscriptionId) || state.subscriptionIds.size > 0) return
      remove(state)
    },
    removeOwner(ownerId: number) {
      const state = states.get(ownerId)
      if (state) remove(state)
    },
    clear() {
      Array.from(states.values()).forEach(remove)
    },
    count(ownerId: number) {
      return states.get(ownerId)?.subscriptionIds.size ?? 0
    },
  }
}

function isSubscribeSuccess(value: unknown): value is { ok: true; status: "ok"; value: () => void } {
  return isRecord(value) && value.ok === true && value.status === "ok" && typeof value.value === "function"
}

function unavailable(reason: (typeof OMNIA_UNAVAILABLE_REASONS)[number]) {
  return { ok: false, status: "unavailable", reason } as const
}

function blocked(reason: (typeof OMNIA_BLOCKED_REASONS)[number]) {
  return { ok: false, status: "blocked", reason } as const
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
