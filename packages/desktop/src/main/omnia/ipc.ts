import { app, BrowserWindow, ipcMain } from "electron"
import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron"
import { registerBillingIpcHandlers } from "./billing"
import { createOmniaOperations } from "./operations"
import { omniaDriverRegistry } from "./registry"
import type { OmniaDriverRegistry } from "./registry"
import { createOmniaSubscriptions } from "./subscriptions"
import {
  parseOmniaExecuteRequest,
  parseOmniaFindRequest,
  parseOmniaObserveRequest,
  parseOmniaSubscriptionId,
} from "./validation"
import type { OmniaDriver, OmniaEvent, OmniaSubscribeIpcResult } from "./types"

export const OMNIA_CHANNELS = {
  getCapabilities: "omnia-get-capabilities",
  observe: "omnia-observe",
  find: "omnia-find",
  execute: "omnia-execute",
  subscribe: "omnia-subscribe",
  unsubscribe: "omnia-unsubscribe",
  event: "omnia-event",
} as const

type SenderState = {
  sender: WebContents
  frame: WebFrameMain
  driver: OmniaDriver
  removeListeners: () => void
}

export function registerOmniaIpcHandlers(registry: OmniaDriverRegistry = omniaDriverRegistry) {
  // Billing is served entirely by the control plane and needs no driver, so it
  // registers with the other control-plane handlers rather than in src/main/ipc.ts.
  registerBillingIpcHandlers()
  const operations = createOmniaOperations(registry)
  const senders = new Map<number, SenderState>()

  const detach = (ownerId: number, expected?: SenderState) => {
    const state = senders.get(ownerId)
    if (!state || (expected && state !== expected)) return
    senders.delete(ownerId)
    state.removeListeners()
    subscriptions.removeOwner(ownerId)
  }

  const publish = (ownerId: number, driver: OmniaDriver, event: OmniaEvent) => {
    const state = senders.get(ownerId)
    if (!state || state.driver !== driver || state.sender.isDestroyed() || state.sender.mainFrame !== state.frame) {
      if (state) detach(ownerId, state)
      return
    }
    try {
      state.frame.send(OMNIA_CHANNELS.event, { event })
    } catch {
      detach(ownerId, state)
    }
  }

  const subscriptions = createOmniaSubscriptions({
    getDriver: () => registry.get(),
    publish,
  })

  const ensureSender = (event: IpcMainInvokeEvent, driver: OmniaDriver) => {
    const existing = senders.get(event.sender.id)
    if (existing?.driver === driver) return { state: existing, created: false }
    if (existing) detach(event.sender.id, existing)
    const frame = event.senderFrame!
    const state: SenderState = {
      sender: event.sender,
      frame,
      driver,
      removeListeners: () => {
        event.sender.removeListener("destroyed", onDestroyed)
        event.sender.removeListener("did-start-navigation", onNavigation)
        event.sender.removeListener("render-process-gone", onProcessGone)
      },
    }
    const onDestroyed = () => detach(event.sender.id, state)
    const onProcessGone = () => detach(event.sender.id, state)
    const onNavigation = (_event: unknown, _url: string, _isInPlace: boolean, isMainFrame: boolean) => {
      if (isMainFrame) detach(event.sender.id, state)
    }
    event.sender.once("destroyed", onDestroyed)
    event.sender.on("did-start-navigation", onNavigation)
    event.sender.once("render-process-gone", onProcessGone)
    senders.set(event.sender.id, state)
    return { state, created: true }
  }

  ipcMain.handle(OMNIA_CHANNELS.getCapabilities, (event) => {
    if (!isValidOmniaSender(event)) return blocked("sender_rejected")
    return operations.getCapabilities()
  })

  ipcMain.handle(OMNIA_CHANNELS.observe, async (event, value: unknown) => {
    if (!isValidOmniaSender(event)) return blocked("sender_rejected")
    try {
      return await operations.observe(parseOmniaObserveRequest(value))
    } catch {
      return blocked("invalid_payload")
    }
  })

  ipcMain.handle(OMNIA_CHANNELS.find, async (event, value: unknown) => {
    if (!isValidOmniaSender(event)) return blocked("sender_rejected")
    try {
      return await operations.find(parseOmniaFindRequest(value))
    } catch {
      return blocked("invalid_payload")
    }
  })

  ipcMain.handle(OMNIA_CHANNELS.execute, async (event, value: unknown) => {
    if (!isValidOmniaSender(event)) return blocked("sender_rejected")
    try {
      return await operations.execute(parseOmniaExecuteRequest(value))
    } catch {
      return blocked("invalid_payload")
    }
  })

  ipcMain.handle(OMNIA_CHANNELS.subscribe, async (event, value: unknown): Promise<OmniaSubscribeIpcResult> => {
    if (!isValidOmniaSender(event)) return blocked("sender_rejected")
    let subscriptionId: string
    try {
      subscriptionId = parseOmniaSubscriptionId(value)
    } catch {
      return blocked("invalid_payload")
    }
    const driver = registry.get()
    if (!driver) return { ok: false, status: "unavailable", reason: "driver_unavailable" }
    const { state, created } = ensureSender(event, driver)
    const result = await subscriptions.subscribe(event.sender.id, subscriptionId)
    if (result.status !== "ok" && created) detach(event.sender.id, state)
    return result
  })

  ipcMain.handle(OMNIA_CHANNELS.unsubscribe, (event, value: unknown) => {
    if (!isValidOmniaSender(event)) return
    subscriptions.unsubscribe(event.sender.id, value)
    if (subscriptions.count(event.sender.id) === 0) detach(event.sender.id)
  })

  const removeRegistryListener = registry.onChange(() => {
    Array.from(senders.keys()).forEach((ownerId) => detach(ownerId))
  })

  const cleanup = () => {
    removeRegistryListener()
    Array.from(senders.keys()).forEach((ownerId) => detach(ownerId))
    Object.values(OMNIA_CHANNELS).forEach((channel) => ipcMain.removeHandler(channel))
  }

  app.once("will-quit", cleanup)
  return cleanup
}

export function isValidOmniaSender(event: IpcMainInvokeEvent) {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame || event.sender.isDestroyed()) return false
  const window = BrowserWindow.fromWebContents(event.sender)
  return !!window && !window.isDestroyed() && window.webContents === event.sender
}

function blocked(reason: "sender_rejected" | "invalid_payload") {
  return { ok: false, status: "blocked", reason } as const
}
