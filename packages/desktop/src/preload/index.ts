import { contextBridge, ipcRenderer, webUtils } from "electron"
import type { ElectronAPI, OmniaEvent, OmniaFailure, Superskill, WslServersEvent } from "./types"
import type { BrowserPanelCommand } from "@opencode-ai/app/context/platform"
import type { UpdaterState } from "@opencode-ai/app/updater"

const updaterCallbacks = new Set<(state: UpdaterState) => void>()
let updaterState: UpdaterState | undefined
let updaterSubscription: Promise<void> | undefined
const updaterHandler = (_: unknown, state: UpdaterState) => {
  updaterState = state
  updaterCallbacks.forEach((callback) => callback(state))
}

const omniaIpc = {
  getCapabilities: "omnia-get-capabilities",
  observe: "omnia-observe",
  find: "omnia-find",
  execute: "omnia-execute",
  subscribe: "omnia-subscribe",
  unsubscribe: "omnia-unsubscribe",
  event: "omnia-event",
} as const

const api: ElectronAPI = {
  // Billing went missing here entirely, which is why the paywall component
  // rendered nothing in the shipping app: no call site could reach a decision.
  billing: {
    entitlement: () => ipcRenderer.invoke("billing-entitlement"),
    check: (capability: string) => ipcRenderer.invoke("billing-check", capability),
    checkout: (plan: string) => ipcRenderer.invoke("billing-checkout", plan),
    portal: () => ipcRenderer.invoke("billing-portal"),
  },
  superskills: {
    list: () => ipcRenderer.invoke("superskills-list"),
    get: (id: string) => ipcRenderer.invoke("superskills-get", id),
    save: (skill: Superskill) => ipcRenderer.invoke("superskills-save", skill),
    remove: (id: string) => ipcRenderer.invoke("superskills-remove", id),
    call: (id: string, method: string, params: unknown) => ipcRenderer.invoke("superskills-call", id, method, params),
  },
  memory: {
    list: (input?: { query?: string; scope?: string; application?: string; limit?: number }) =>
      ipcRenderer.invoke("memories-list", input),
    remove: (id: string) => ipcRenderer.invoke("memories-remove", id),
    forget: (input: { query?: string; key?: string; scope?: string; application?: string }) =>
      ipcRenderer.invoke("memories-forget", input),
    stats: () => ipcRenderer.invoke("memories-stats"),
  },
  specialists: {
    get: () => invokeWithServerMessage("specialists-get"),
    save: (specialists) => invokeWithServerMessage("specialists-save", specialists),
    reset: () => invokeWithServerMessage("specialists-reset"),
  },
  runs: {
    list: () => invokeWithServerMessage("runs-list"),
    create: (input) => invokeWithServerMessage("runs-create", input),
    update: (id, patch) => invokeWithServerMessage("runs-update", id, patch),
    remove: (id) => invokeWithServerMessage("runs-remove", id),
    once: (input) => invokeWithServerMessage("runs-once", input),
  },
  auth: {
    status: () => ipcRenderer.invoke("omnia-auth-status"),
    signIn: () => ipcRenderer.invoke("omnia-auth-sign-in"),
    signOut: () => ipcRenderer.invoke("omnia-auth-sign-out"),
  },
  computers: {
    list: () => ipcRenderer.invoke("computers-list"),
    stop: (computerId: string, reason?: string) => ipcRenderer.invoke("computers-stop", computerId, reason),
    connect: (computerId: string) => ipcRenderer.invoke("computers-connect", computerId),
    pair: {
      create: (name?: string) => ipcRenderer.invoke("computers-pair-create", name),
      cancel: (code: string) => ipcRenderer.invoke("computers-pair-cancel", code),
      join: (code: string) => ipcRenderer.invoke("computers-pair-join", code),
      leave: () => ipcRenderer.invoke("computers-pair-leave"),
      status: () => ipcRenderer.invoke("computers-pair-status"),
    },
    controlPlane: {
      get: () => ipcRenderer.invoke("computers-control-plane-get"),
      set: (url: string | null) => ipcRenderer.invoke("computers-control-plane-set", url),
    },
    credentials: {
      list: (computerId: string) => ipcRenderer.invoke("credentials-list", computerId),
      save: (input) => ipcRenderer.invoke("credentials-save", input),
      remove: (computerId: string, id: string) => ipcRenderer.invoke("credentials-remove", computerId, id),
    },
  },
  computerUse: {
    models: () => ipcRenderer.invoke("computer-use-models"),
    status: () => ipcRenderer.invoke("computer-use-status"),
    settings: () => ipcRenderer.invoke("computer-use-settings"),
    updateSettings: (patch) => ipcRenderer.invoke("computer-use-settings-update", patch),
    download: (id: string) => ipcRenderer.invoke("computer-use-model-download", id),
    load: (id: string) => ipcRenderer.invoke("computer-use-model-load", id),
    unload: (id: string) => ipcRenderer.invoke("computer-use-model-unload", id),
    remove: (id: string) => ipcRenderer.invoke("computer-use-model-remove", id),
    runtimes: () => ipcRenderer.invoke("computer-use-runtimes"),
    downloadRuntime: (id: string) => ipcRenderer.invoke("computer-use-runtime-download", id),
    removeRuntime: (id: string) => ipcRenderer.invoke("computer-use-runtime-remove", id),
    calibration: () => ipcRenderer.invoke("computer-use-calibration"),
    calibrationStart: () => ipcRenderer.invoke("computer-use-calibration-start"),
    calibrationMeasure: (pointId: string) => ipcRenderer.invoke("computer-use-calibration-measure", pointId),
    calibrationSave: (measurements: unknown) => ipcRenderer.invoke("computer-use-calibration-save", measurements),
    calibrationReset: () => ipcRenderer.invoke("computer-use-calibration-reset"),
  },
  browserPanel: {
    register: (input) => ipcRenderer.invoke("browser-panel-register", input),
    unregister: (webContentsId) => ipcRenderer.invoke("browser-panel-unregister", webContentsId),
    activate: (webContentsId) => ipcRenderer.invoke("browser-panel-activate", webContentsId),
    list: () => ipcRenderer.invoke("browser-panel-list"),
    answerDialog: (input) => ipcRenderer.invoke("browser-panel-answer-dialog", input),
    onCommand: (callback) => {
      const handler = (_: unknown, command: unknown) => {
        if (!isBrowserPanelCommand(command)) return
        callback(command)
      }
      ipcRenderer.on("browser-panel-command", handler)
      return () => ipcRenderer.removeListener("browser-panel-command", handler)
    },
  },
  omnia: {
    getCapabilities: () => ipcRenderer.invoke(omniaIpc.getCapabilities),
    observe: (request) =>
      request === undefined ? ipcRenderer.invoke(omniaIpc.observe) : ipcRenderer.invoke(omniaIpc.observe, request),
    find: (request) => ipcRenderer.invoke(omniaIpc.find, request),
    execute: (request) => ipcRenderer.invoke(omniaIpc.execute, request),
    subscribe: async (listener) => {
      if (typeof listener !== "function") return { ok: false, status: "blocked", reason: "invalid_payload" } as const
      const subscriptionId = createSubscriptionId()
      const handler = (_: unknown, value: unknown) => {
        if (!isRecord(value) || !isRecord(value.event)) return
        listener(value.event as OmniaEvent)
      }
      ipcRenderer.on(omniaIpc.event, handler)
      let result: unknown
      try {
        result = await ipcRenderer.invoke(omniaIpc.subscribe, subscriptionId)
      } catch (error) {
        ipcRenderer.removeListener(omniaIpc.event, handler)
        throw error
      }
      if (!isRecord(result) || typeof result.status !== "string") {
        ipcRenderer.removeListener(omniaIpc.event, handler)
        return { ok: false, status: "blocked", reason: "operation_failed" } as const
      }
      if (result.status !== "ok") {
        ipcRenderer.removeListener(omniaIpc.event, handler)
        return result as OmniaFailure
      }
      if (result.ok !== true || !isRecord(result.value) || result.value.subscriptionId !== subscriptionId) {
        ipcRenderer.removeListener(omniaIpc.event, handler)
        return { ok: false, status: "blocked", reason: "operation_failed" } as const
      }
      let closed = false
      return {
        ok: true,
        status: "ok",
        unsubscribe: async () => {
          if (closed) return
          closed = true
          ipcRenderer.removeListener(omniaIpc.event, handler)
          try {
            await ipcRenderer.invoke(omniaIpc.unsubscribe, subscriptionId)
          } catch (error) {
            closed = false
            throw error
          }
        },
      }
    },
  },
  killSidecar: () => ipcRenderer.invoke("kill-sidecar"),
  installCli: () => ipcRenderer.invoke("install-cli"),
  awaitInitialization: () => ipcRenderer.invoke("await-initialization"),
  wslServers: {
    getState: () => ipcRenderer.invoke("wsl-servers-get-state"),
    subscribe: (cb) => {
      const handler = (_: unknown, event: WslServersEvent) => cb(event)
      ipcRenderer.on("wsl-servers-event", handler)
      void ipcRenderer.invoke("wsl-servers-subscribe")
      return () => {
        ipcRenderer.removeListener("wsl-servers-event", handler)
        void ipcRenderer.invoke("wsl-servers-unsubscribe")
      }
    },
    probeRuntime: () => ipcRenderer.invoke("wsl-servers-probe-runtime"),
    refreshDistros: () => ipcRenderer.invoke("wsl-servers-refresh-distros"),
    installWsl: () => ipcRenderer.invoke("wsl-servers-install-wsl"),
    installDistro: (name) => ipcRenderer.invoke("wsl-servers-install-distro", name),
    probeAddable: (distros) => ipcRenderer.invoke("wsl-servers-probe-addable", distros),
    installOpencode: (name) => ipcRenderer.invoke("wsl-servers-install-opencode", name),
    openTerminal: (name) => ipcRenderer.invoke("wsl-servers-open-terminal", name),
    addServer: (distro) => ipcRenderer.invoke("wsl-servers-add", distro),
    removeServer: (id) => ipcRenderer.invoke("wsl-servers-remove", id),
    startServer: (id) => ipcRenderer.invoke("wsl-servers-start", id),
  },
  updater: {
    subscribe: async (cb) => {
      updaterCallbacks.add(cb)
      if (updaterState) cb(updaterState)
      if (!updaterSubscription) {
        ipcRenderer.on("updater-state", updaterHandler)
        updaterSubscription = ipcRenderer.invoke("updater-subscribe")
      }
      await updaterSubscription
      return () => {
        updaterCallbacks.delete(cb)
        if (updaterCallbacks.size > 0) return
        ipcRenderer.removeListener("updater-state", updaterHandler)
        updaterSubscription = undefined
        void ipcRenderer.invoke("updater-unsubscribe")
      }
    },
    check: () => ipcRenderer.invoke("updater-check"),
    install: () => ipcRenderer.invoke("updater-install"),
  },
  consumeInitialDeepLinks: () => ipcRenderer.invoke("consume-initial-deep-links"),
  getDefaultServerUrl: () => ipcRenderer.invoke("get-default-server-url"),
  setDefaultServerUrl: (url) => ipcRenderer.invoke("set-default-server-url", url),
  isFirstLaunchOnboardingPending: () => ipcRenderer.invoke("is-first-launch-onboarding-pending"),
  finishFirstLaunchOnboarding: (createDefaultProject) =>
    ipcRenderer.invoke("finish-first-launch-onboarding", createDefaultProject),
  isOldLayoutEligible: () => ipcRenderer.invoke("is-old-layout-eligible"),
  getDisplayBackend: () => ipcRenderer.invoke("get-display-backend"),
  setDisplayBackend: (backend) => ipcRenderer.invoke("set-display-backend", backend),
  checkAppExists: (appName) => ipcRenderer.invoke("check-app-exists", appName),
  resolveAppPath: (appName) => ipcRenderer.invoke("resolve-app-path", appName),
  storeGet: (name, key) => ipcRenderer.invoke("store-get", name, key),
  storeSet: (name, key, value) => ipcRenderer.invoke("store-set", name, key, value),
  storeDelete: (name, key) => ipcRenderer.invoke("store-delete", name, key),
  storeClear: (name) => ipcRenderer.invoke("store-clear", name),
  storeKeys: (name) => ipcRenderer.invoke("store-keys", name),
  storeLength: (name) => ipcRenderer.invoke("store-length", name),
  draftGet: (key) => ipcRenderer.invoke("draft-get", key),
  draftSet: (key, value) => ipcRenderer.invoke("draft-set", key, value),
  draftDelete: (key) => ipcRenderer.invoke("draft-delete", key),
  draftBlobPut: (data) => ipcRenderer.invoke("draft-blob-put", data),
  draftBlobGet: (id) => ipcRenderer.invoke("draft-blob-get", id),

  getWindowID: () => ipcRenderer.invoke("get-window-id"),
  onMenuCommand: (cb) => {
    const handler = (_: unknown, id: string) => cb(id)
    ipcRenderer.on("menu-command", handler)
    return () => ipcRenderer.removeListener("menu-command", handler)
  },
  onDeepLink: (cb) => {
    const handler = (_: unknown, urls: string[]) => cb(urls)
    ipcRenderer.on("deep-link", handler)
    return () => ipcRenderer.removeListener("deep-link", handler)
  },

  openDirectoryPicker: (opts) => ipcRenderer.invoke("open-directory-picker", opts),
  openFilePicker: (opts) => ipcRenderer.invoke("open-file-picker", opts),
  readPickedFile: (token, path) => ipcRenderer.invoke("read-picked-file", token, path),
  releasePickedFiles: (token) => ipcRenderer.invoke("release-picked-files", token),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  saveFilePicker: (opts) => ipcRenderer.invoke("save-file-picker", opts),
  openExternal: (url) => ipcRenderer.send("open-external", url),
  openLocalFile: (url) => ipcRenderer.send("open-local-file", url),
  openPath: (path, app) => ipcRenderer.invoke("open-path", path, app),
  revealPath: (path) => ipcRenderer.invoke("reveal-path", path),
  readClipboardImage: () => ipcRenderer.invoke("read-clipboard-image"),
  getWindowFocused: () => ipcRenderer.invoke("get-window-focused"),
  getWindowFullscreen: () => ipcRenderer.invoke("get-window-fullscreen"),
  onWindowFullscreenChanged: (cb) => {
    const handler = (_: unknown, fullscreen: boolean) => cb(fullscreen)
    ipcRenderer.on("window-fullscreen-changed", handler)
    return () => ipcRenderer.removeListener("window-fullscreen-changed", handler)
  },
  setWindowFocus: () => ipcRenderer.invoke("set-window-focus"),
  showWindow: () => ipcRenderer.invoke("show-window"),
  relaunch: () => ipcRenderer.send("relaunch"),
  getZoomFactor: () => ipcRenderer.invoke("get-zoom-factor"),
  setZoomFactor: (factor) => ipcRenderer.invoke("set-zoom-factor", factor),
  getPinchZoomEnabled: () => ipcRenderer.invoke("get-pinch-zoom-enabled"),
  setPinchZoomEnabled: (enabled) => ipcRenderer.invoke("set-pinch-zoom-enabled", enabled),
  onPinchZoomEnabledChanged: (cb) => {
    const handler = (_: unknown, enabled: boolean) => cb(enabled)
    ipcRenderer.on("pinch-zoom-enabled-changed", handler)
    return () => ipcRenderer.removeListener("pinch-zoom-enabled-changed", handler)
  },
  onZoomFactorChanged: (cb) => {
    const handler = (_: unknown, factor: number) => cb(factor)
    ipcRenderer.on("zoom-factor-changed", handler)
    return () => ipcRenderer.removeListener("zoom-factor-changed", handler)
  },
  setTitlebar: (theme) => ipcRenderer.invoke("set-titlebar", theme),
  runDesktopMenuAction: (action) => ipcRenderer.invoke("run-desktop-menu-action", action),
  setBackgroundColor: (color: string) => ipcRenderer.invoke("set-background-color", color),
  setAgentWorking: (working) => ipcRenderer.send("agent-working", working),
  exportDebugLogs: () => ipcRenderer.invoke("export-debug-logs"),
  setForceFocus: (enabled) => ipcRenderer.invoke("set-force-focus", enabled),
  recordFatalRendererError: (error) => ipcRenderer.invoke("record-fatal-renderer-error", error),
  setNativeTranslations: (bundle) => ipcRenderer.invoke("set-native-translations", bundle),
}

// Electron prefixes a rejected invoke with "Error invoking remote method '<channel>': Error: ",
// which would hide the server's own sentence behind transport noise.
function invokeWithServerMessage(channel: string, ...args: unknown[]) {
  return ipcRenderer.invoke(channel, ...args).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ""))
  })
}

function createSubscriptionId() {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isBrowserPanelCommand(value: unknown): value is BrowserPanelCommand {
  if (!isRecord(value) || typeof value.kind !== "string") return false
  if (value.kind === "open") return typeof value.requestId === "string" && typeof value.url === "string"
  if (value.kind === "activate" || value.kind === "close") return typeof value.tabId === "number"
  if (value.kind === "dialog") {
    return (
      typeof value.tabId === "number" &&
      typeof value.type === "string" &&
      typeof value.message === "string" &&
      (value.defaultPrompt === undefined || typeof value.defaultPrompt === "string") &&
      (value.frameUrl === undefined || typeof value.frameUrl === "string")
    )
  }
  return false
}

contextBridge.exposeInMainWorld("api", api)
