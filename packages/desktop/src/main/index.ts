import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow } from "electron"

import { Deferred, Effect, Fiber } from "effect"
import contextMenu from "electron-context-menu"
import { Browser } from "@opencode-ai/omnia"

import type { ServerReadyData } from "../preload/types"
import { checkAppExists, resolveAppPath } from "./apps"
import { CHANNEL, UPDATER_ENABLED } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand } from "./ipc"
import { forwardInitializationFailure } from "./initialization"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { createMenu } from "./menu"
import {
  finishFirstLaunchOnboarding,
  initializeOldLayoutEligibility,
  isFirstLaunchOnboardingPending,
  isOldLayoutEligible,
} from "./onboarding"
import {
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  spawnLocalServer,
  type SidecarListener,
  type SpawnLocalServerOptions,
} from "./server"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import { safeWebContentsURL } from "./window-state"
import {
  getLastFocusedWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setAppQuitting,
  setBackgroundColor,
  setDockIcon,
  applyBrandIcon,
  restoreMainWindows,
} from "./windows"
import { createWslServersController } from "./wsl/servers"
import { createAgentWorking } from "./omnia/agent-working"
import {
  destroyBrowserViewBridge,
  registerBrowserViewIpc,
  startBrowserViewBridge,
} from "./omnia/browser-view"
import {
  agentEventSource,
  createRemoteBrowserHandler,
  readRegisteredComputerId,
  resolvedControlPlaneUrl,
  setNativeActionObserver,
  setRemoteBrowserHandler,
} from "./omnia/remote-agent"
import { createLegalController } from "./legal"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { controlPlaneFingerprint } from "./omnia/control-plane"
import { readSessionProfileEmail } from "./omnia/auth-session"
import { enterprisePolicy, enterpriseProfile } from "./omnia/enterprise"
import { watchControlPlaneSession, type ControlPlaneSessionWatch } from "./omnia/control-plane-session"
import { spawnWslSidecar } from "./wsl/sidecar"
import { migrate } from "./migrate"
import { cleanupStoreFiles } from "./store-cleanup"
import { startBackgroundCli } from "./background-cli"
import { setNativeTranslations } from "./native-translations"

const APP_NAMES: Record<string, string> = {
  dev: "Omnia Dev",
  beta: "Omnia Beta",
  prod: "Omnia",
}
const APP_IDS: Record<string, string> = {
  dev: "io.omnia.desktop.dev",
  beta: "io.omnia.desktop.beta",
  prod: "io.omnia.desktop",
}
const TEST_ONBOARDING = process.env.OPENCODE_TEST_ONBOARDING === "1"
const SIDECAR_VERSION = process.env.OPENCODE_SIDECAR_V2 === "1" ? "v2" : "v1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let server: SidecarListener | null = null
let sidecarTarget: SidecarTarget | null = null
let controlPlaneSession: ControlPlaneSessionWatch | null = null

// The sidecar is forked with the control-plane credentials the Omnia computer
// tools need (see createSidecarEnv) and nothing re-reads them, so a sign-in that
// lands while the app is already running has to re-fork it. The restart reuses
// the same port and password so the renderer keeps the ServerReadyData it
// resolved, and the reload is what makes its event stream reconnect to the new
// process.
const CONTROL_PLANE_SESSION_POLL_MS = 5_000
const SIDECAR_RESTART_HEALTH_TIMEOUT_MS = 30_000

type SidecarTarget = {
  hostname: string
  port: number
  password: string
  options: SpawnLocalServerOptions
}

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  const win = getLastFocusedWindow()
  if (win) sendDeepLinks(win, urls)
}

async function killSidecar() {
  if (!server) return
  const current = server
  // Keep the reference until the stop settles so a failed teardown can be
  // retried instead of leaking the child process.
  await current.stop()
  server = null
}

async function restartSidecar() {
  const target = sidecarTarget
  if (target === null) return
  logger.log("restarting sidecar for the control-plane session", { port: target.port })
  const previous = server
  server = null
  await previous?.stop()
  const { listener, health } = await spawnLocalServer(target.hostname, target.port, target.password, target.options)
  server = listener
  await Promise.race([
    health.wait.catch((error) => logger.error("restarted sidecar never became healthy", error)),
    new Promise((resolve) => setTimeout(resolve, SIDECAR_RESTART_HEALTH_TIMEOUT_MS)),
  ])
  for (const window of BrowserWindow.getAllWindows()) window.reload()
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

  // A tenant build uses its own id so it never shares the public app's
  // userData, and therefore never inherits its sign-in or local state.
  const tenant = app.isPackaged ? enterpriseProfile() : undefined
  const appId = tenant?.appId ?? (app.isPackaged ? APP_IDS[CHANNEL] : "io.omnia.desktop.dev")
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.OPENCODE_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  // A tenant build is named by its branding (the manifest's productName), while
  // the profile's `name` stays the distribution name from the schema.
  app.setName(
    tenant === undefined
      ? app.isPackaged
        ? APP_NAMES[CHANNEL]
        : "Omnia Dev"
      : tenant.branding.productName?.trim() || tenant.name,
  )
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  initializeOldLayoutEligibility(app.getPath("userData"))
  logger = initLogging()
  initCrashReporter()

  const wslServers = createWslServersController(
    app.getVersion(),
    async (distro) => {
      logger.log("spawning wsl sidecar", { distro })
      return spawnWslSidecar(distro, {
        onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
    },
  )
  // Teardown must never reject: these callers are quit, relaunch and signal
  // paths, where a rejection would skip `app.quit()` and surface as an
  // unhandled rejection instead of the intended shutdown.
  const stopSidecars = async () => {
    try {
      controlPlaneSession?.stop()
      controlPlaneSession = null
      // A tick must never re-fork the sidecar while the app is shutting down.
      sidecarTarget = null
      await killSidecar()
      wslServers.stopAll()
    } catch (error) {
      logger.error("failed to stop sidecars", error)
    }
  }
  const relaunch = () => {
    setAppQuitting()
    void stopSidecars().finally(() => {
      app.relaunch()
      app.quit()
    })
  }

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  // Keep the renderer at full speed: no timer throttling, no backgrounding of
  // occluded windows, and no IPC flood protection pausing for the agent's
  // high-frequency event streams.
  app.commandLine.appendSwitch("disable-renderer-backgrounding")
  app.commandLine.appendSwitch("disable-background-timer-throttling")
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows")
  app.commandLine.appendSwitch("disable-ipc-flooding-protection")
  // macOS composites the window through the GPU, but Chromium can still have the
  // machine's GPU on its blocklist and raster every layer on the CPU: on a Retina
  // display that turns each animation (a full-width surface like the sidebar's
  // collapse included) into hand-painted full-screen work, which is what makes
  // them stutter. Ignore the blocklist and keep rasterization on the GPU.
  if (process.platform === "darwin") {
    app.commandLine.appendSwitch("ignore-gpu-blocklist")
    app.commandLine.appendSwitch("enable-gpu-rasterization")
    // Which renderer this machine actually got belongs in the log: a machine that
    // fell back to software raster has to be visible there, not guessed at.
    app.on("gpu-info-update", () => {
      const status = app.getGPUFeatureStatus()
      logger.log("gpu feature status", {
        gpu_compositing: status.gpu_compositing,
        rasterization: status.rasterization,
        "2d_canvas": status["2d_canvas"],
        webgl: status.webgl,
      })
    })
  }
  // Chromium's background services (component updater, domain reliability,
  // metrics) are pure startup noise for a locally hosted desktop app.
  app.commandLine.appendSwitch("disable-background-networking")
  app.commandLine.appendSwitch("disable-component-update")
  app.commandLine.appendSwitch("disable-domain-reliability")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  const shellEnv = preferAppEnv(app.getPath("userData"))

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("omnia://") || arg.startsWith("opencode://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    const win = getLastFocusedWindow()
    if (win) {
      win.show()
      win.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    setAppQuitting()
    void stopSidecars()
  })

  app.on("will-quit", () => {
    setAppQuitting()
    void stopSidecars()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: safeWebContentsURL(webContents), details }, "error")
  })

  setRelaunchHandler(() => {
    relaunch()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      setAppQuitting()
      void stopSidecars().finally(() => app.quit())
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()

  yield* Effect.promise(() => app.whenReady())

  // A missing embedded-browser bridge must not stop the app: browser actions
  // then fail closed at the control plane. When it starts, every remote-agent
  // registration serves them through the local webview runtime.
  const browserBridge = yield* Effect.promise(async () => {
    try {
      return await startBrowserViewBridge()
    } catch (error) {
      logger.warn("failed to start the embedded browser bridge", error)
      return undefined
    }
  })
  if (browserBridge !== undefined) {
    setRemoteBrowserHandler(createRemoteBrowserHandler(new Browser.BrowserRuntime({ embedded: browserBridge })))
    app.once("will-quit", () =>
      void destroyBrowserViewBridge().catch((error) => logger.error("failed to stop the embedded browser bridge", error)),
    )
  }

  const agentWorking = createAgentWorking({ computerId: () => readRegisteredComputerId() })
  // The runtime's grab notifications are the only local signal that the user
  // took input back with Escape; without them a stale freeze outlives the run.
  agentWorking.attach(agentEventSource())
  setNativeActionObserver({
    started: () => agentWorking.notifyActionStart(),
    ended: (ok: boolean) => agentWorking.notifyActionEnd(ok),
  })
  // before-quit covers relaunch and the updater install, which never reach
  // will-quit; the release must not wait behind a freeze that may be hung.
  app.on("before-quit", () => agentWorking.releaseNow())
  app.once("will-quit", () => {
    setNativeActionObserver(undefined)
    agentWorking.destroy()
  })

  if (!TEST_ONBOARDING) migrate()
  yield* Effect.promise(() => cleanupStoreFiles(app.getPath("userData"))).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        if (result.deleted.length === 0) return
        logger.log("cleaned scoped store files", { count: result.deleted.length, scanned: result.scanned })
      }),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to clean scoped store files", error)
      }),
    ),
  )
  app.setAsDefaultProtocolClient("omnia")
  app.setAsDefaultProtocolClient("opencode")
  registerRendererProtocol()
  setDockIcon()
  // Bans and terms acceptance are decided before the local server exists: a
  // banned installation must not open its database (it gets sealed instead) and
  // must not answer on loopback at all.
  const legal = createLegalController({
    userDataPath: app.getPath("userData"),
    banUrl: process.env.OMNIA_BAN_URL ?? controlPlaneBanUrl(),
    account: readSessionProfileEmail,
    beforeSeal: async () => {
      await stopSidecars()
    },
    log: (message, meta) => logger.log(`legal: ${message}`, meta),
  })
  const legalStatus = yield* Effect.promise(() => legal.startup())
  if (legalStatus.banned) logger.warn("legal: installation banned", { reason: legalStatus.reason })

  const updater = setupAutoUpdater(stopSidecars)
  const menuDeps = {
    trigger: (id: string) => {
      const win = getLastFocusedWindow()
      if (win) sendMenuCommand(win, id)
    },
    checkForUpdates: () => void showUpdaterDialog(updater, true),
    relaunch,
  }
  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    relaunch,
    awaitInitialization: Effect.fnUntraced(
      function* () {
        logger.log("awaiting server ready")
        const res = yield* Deferred.await(serverReady)
        logger.log("server ready", { url: res.url })
        return res
      },
      (e) => Effect.runPromise(e),
    ),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    isFirstLaunchOnboardingPending,
    finishFirstLaunchOnboarding,
    isOldLayoutEligible,
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    updater,
    showUpdater: () => showUpdaterDialog(updater, true),
    setBackgroundColor: (color) => setBackgroundColor(color),
    setAgentWorking: (sourceId, working) => agentWorking.setRendererWorking(sourceId, working),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
    setNativeTranslations: (bundle) => {
      if (setNativeTranslations(bundle)) createMenu(menuDeps)
    },
    legal,
    quit: () => app.quit(),
  })
  registerWslIpcHandlers(wslServers)
  registerBrowserViewIpc()
  if (UPDATER_ENABLED) {
    void updater.start()
    const updateTimer = setInterval(() => void updater.check(), 10 * 60 * 1000)
    updateTimer.unref()
    app.once("will-quit", () => clearInterval(updateTimer))
  }
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  const loadingTask = legalStatus.banned
    ? undefined
    : yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { version: SIDECAR_VERSION })

    ensureLoopbackNoProxy()
    useEnvProxy()

    if (SIDECAR_VERSION === "v2") {
      logger.log("spawning v2 sidecar")
      const sidecar = yield* Effect.promise(() => startBackgroundCli(logger, shellEnv?.XDG_STATE_HOME))
      yield* Deferred.succeed(serverReady, {
        url: sidecar.url,
        username: sidecar.username,
        password: sidecar.password,
      })

      if (process.platform === "win32") {
        void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
      }

      logger.log("loading task finished")
      return
    }

    const port = yield* Effect.gen(function* () {
      const fromEnv = process.env.OPENCODE_PORT
      if (fromEnv) {
        const parsed = Number.parseInt(fromEnv, 10)
        if (!Number.isNaN(parsed)) return parsed
      }

      const res = yield* Deferred.make<number, unknown>()
      const socket = createServer()
      socket.on("error", (e) => Deferred.failSync(res, () => e))
      socket.listen(0, "127.0.0.1", () => {
        const address = socket.address()
        if (typeof address !== "object" || !address) {
          socket.close()
          Deferred.failSync(res, () => new Error("Failed to get port"))
          return
        }
        const port = address.port
        socket.close(() => Effect.runSync(Deferred.succeed(res, port)))
      })

      return yield* Deferred.await(res)
    })
    const hostname = "127.0.0.1"
    const url = `http://${hostname}:${port}`
    const password = randomUUID()

    logger.log("spawning sidecar", { url })
    const options = {
      userDataPath: app.getPath("userData"),
      onStdout: (message: string) => writeLog("server", "stdout", { message }),
      onStderr: (message: string) => writeLog("server", "stderr", { message }, "warn"),
      onExit: (code: number) => writeLog("utility", "sidecar exited", { code }, "warn"),
    }
    const { listener, health } = yield* Effect.promise(() => spawnLocalServer(hostname, port, password, options))
    server = listener
    sidecarTarget = { hostname, port, password, options }
    // A sign-in can be the moment an account ban becomes visible, so the check
    // runs before the sidecar is re-forked: refresh() seals the database first,
    // and a relaunch is what shows the ban screen against a stopped server.
    const restartForSession = async () => {
      const checked = await legal.refresh()
      if (checked.status.banned) {
        logger.warn("legal: installation banned after sign-in", { reason: checked.status.reason })
        relaunch()
        return
      }
      await restartSidecar()
    }
    controlPlaneSession = watchControlPlaneSession({
      fingerprint: controlPlaneFingerprint,
      restart: restartForSession,
      intervalMs: CONTROL_PLANE_SESSION_POLL_MS,
      onError: (error) => logger.error("failed to restart the sidecar after the control-plane session changed", error),
    })
    yield* Deferred.succeed(serverReady, {
      url,
      username: "opencode",
      password,
    })

    if (process.platform === "win32") {
      void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
    }

    yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
        }),
      ),
    )

    logger.log("loading task finished")
  }).pipe(forwardInitializationFailure(serverReady), Effect.forkChild)

  if (loadingTask !== undefined) yield* Fiber.await(loadingTask)

  app.on("window-all-closed", () => {
    if (process.platform === "darwin") return
    app.quit()
  })
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    restoreMainWindows()
  })

  const windows = restoreMainWindows()
  if (windows.length) createMenu(menuDeps)
  // A managed install draws the admin's mark in its window and dock. This runs
  // after the first window exists (so it can retitle that one) and never blocks
  // startup: an unreachable console keeps the shipped icon.
  void enterprisePolicy()
    .then((policy) => applyBrandIcon(policy?.branding.iconUrl))
    .catch(() => undefined)
})

// The ban endpoint follows the configured control plane when the operator has
// one, so a managed deployment can enforce bans without extra configuration.
function controlPlaneBanUrl(): string | undefined {
  const base = process.env.OMNIA_BAN_URL ?? resolvedControlPlaneUrl()
  if (base === undefined || base.length === 0) return undefined
  try {
    return new URL("v1/legal/status", base.endsWith("/") ? base : `${base}/`).toString()
  } catch {
    return undefined
  }
}

Effect.runFork(main)
