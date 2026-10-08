import { existsSync, readFileSync, rmSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { app, ipcMain } from "electron"
import { decryptString, encryptString, writeSecretFile } from "./secret-storage"
import { Browser, Daemon, Pairing, Remote } from "@opencode-ai/omnia"
import { controlPlaneAuth, fetchControlPlane } from "./control-plane"
import { readAuthSession } from "./auth-session"
import { createControlPlaneDriver } from "./control-plane-driver"
import type { AgentActivityEvent } from "./agent-state"
import { registerOmniaDriver, omniaDriverRegistry } from "./registry"
import { createPlatformHostDriver } from "./server-host"

export interface RemoteAgentConfig {
  serverUrl: string
  computerId: string
  token: string
  encrypted?: boolean
}

let agent: Remote.RemoteAgent | undefined
let config: RemoteAgentConfig | undefined
let activeDriver: ReturnType<typeof createPlatformHostDriver>
let remoteBrowserHandler: Remote.RemoteBrowserHandler | undefined
let controlPlane: { computerId: string; serverUrl: string } | undefined
let registeredFingerprint: string | undefined
let suppressedFingerprint: string | undefined
let registering = false
let runtimeDriverUnregister: (() => void) | undefined

function configFile(): string {
  return join(app.getPath("userData"), "remote-agent.json")
}

function controlPlaneFile(): string {
  return join(app.getPath("userData"), "remote-agent-control-plane.json")
}

function registrationFile(): string {
  return join(app.getPath("userData"), "control-plane-computer.json")
}

export function readRegisteredComputerId(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(registrationFile(), "utf8")) as { computerId?: unknown }
    return typeof parsed.computerId === "string" && parsed.computerId.length > 0 ? parsed.computerId : undefined
  } catch {
    return undefined
  }
}

function writeRegisteredComputerId(computerId: string): void {
  writeSecretFile(registrationFile(), JSON.stringify({ computerId }))
}

function decryptToken(value: string): string | undefined {
  return decryptString(value)
}

function encodeConfig(next: RemoteAgentConfig): RemoteAgentConfig {
  const payload = encryptString(next.token)
  if (payload === undefined) {
    return { serverUrl: next.serverUrl, computerId: next.computerId, token: next.token }
  }
  return {
    serverUrl: next.serverUrl,
    computerId: next.computerId,
    token: payload,
    encrypted: true,
  }
}

export function loadRemoteAgentConfig(): RemoteAgentConfig | undefined {
  const file = configFile()
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RemoteAgentConfig>
    if (
      typeof parsed.serverUrl !== "string" ||
      typeof parsed.computerId !== "string" ||
      typeof parsed.token !== "string"
    ) {
      return undefined
    }
    if (parsed.encrypted === true) {
      const token = decryptToken(parsed.token)
      if (token === undefined) return undefined
      return { serverUrl: parsed.serverUrl, computerId: parsed.computerId, token, encrypted: true }
    }
    return { serverUrl: parsed.serverUrl, computerId: parsed.computerId, token: parsed.token }
  } catch {
    return undefined
  }
}

export function persistRemoteAgentConfig(next: RemoteAgentConfig | undefined): void {
  const file = configFile()
  if (next === undefined) {
    rmSync(file, { force: true })
    return
  }
  writeSecretFile(file, JSON.stringify(encodeConfig(next)))
}

// The Ed25519 keypair that authenticates this runtime to the control plane is
// always encrypted with the OS keychain (safeStorage): without one there is
// nowhere safe to put the private key, so it is never written at all.
function remoteKeyStorage(): Remote.RemoteKeyStorage {
  const file = join(app.getPath("userData"), "remote-key.json")
  return {
    load: () => {
      if (!existsSync(file)) return undefined
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { encrypted?: unknown; payload?: unknown }
        if (parsed.encrypted === true && typeof parsed.payload === "string") {
          const decrypted = decryptString(parsed.payload)
          if (decrypted === undefined) return undefined
          return JSON.parse(decrypted) as Remote.RemoteKeyPair
        }
        // A key stored in the clear by an older build still loads, so a paired
        // server is not stranded; nothing new is ever written this way.
        return parsed as Remote.RemoteKeyPair
      } catch {
        return undefined
      }
    },
    save: (keys) => {
      const payload = encryptString(JSON.stringify(keys))
      // The private key is the credential every paired server trusts, and
      // safeStorage is unavailable by default on macOS and on Linux without a
      // keyring. Persisting it in the clear would hand any local account the
      // remote identity, so the registration fails instead.
      if (payload === undefined) {
        throw new Error(
          "This computer's remote key cannot be stored because no system keychain is available, so Omnia refuses to save it unencrypted. Set up a system keychain (or unlock the login keychain) and try again.",
        )
      }
      writeSecretFile(file, JSON.stringify({ encrypted: true, payload }))
    },
  }
}

export function normalizeControlPlaneUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed.length === 0) throw new Error("Enter a control-plane URL.")
  const address = hasScheme(trimmed) ? trimmed : `${isLocalAddress(hostOf(trimmed)) ? "http" : "https"}://${trimmed}`
  let url: URL
  try {
    url = new URL(address)
  } catch {
    throw new Error("That control-plane address is not a valid URL.")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The control plane must use https://. Plain http:// is allowed only for local or LAN addresses.")
  }
  if (url.protocol === "http:" && !isLocalAddress(url.hostname)) {
    throw new Error("Use an https:// control-plane URL. Plain http:// is allowed only for local or LAN addresses.")
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("The control-plane URL must not include a username or password.")
  }
  return url.toString().replace(/\/+$/, "")
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
}

function hostOf(value: string): string {
  try {
    return new URL(`http://${value}`).hostname
  } catch {
    return ""
  }
}

function isLocalAddress(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "")
  if (name.length === 0) return false
  if (name === "localhost" || name === "::1" || name.endsWith(".localhost")) return true
  if (name.endsWith(".local")) return true
  // Dotless names resolve on the local network, not the public internet.
  if (!name.includes(".") && !name.includes(":")) return true
  const octets = name.split(".").map(Number)
  if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    if (octets[0] === 10 || octets[0] === 127) return true
    if (octets[0] === 192 && octets[1] === 168) return true
    if (octets[0] === 169 && octets[1] === 254) return true
    if (octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31) return true
    return false
  }
  if (name.includes(":")) return /^(fe80|fc|fd)/i.test(name)
  return false
}

export function readControlPlaneUrl(): string | undefined {
  const file = controlPlaneFile()
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { url?: unknown }
      if (typeof parsed.url === "string" && parsed.url.length > 0) return parsed.url
    } catch {
      // A corrupt file falls back to the environment default.
    }
  }
  const fromEnv = process.env.OMNIA_CONTROL_PLANE_URL?.trim()
  if (fromEnv === undefined || fromEnv.length === 0) return undefined
  try {
    return normalizeControlPlaneUrl(fromEnv)
  } catch {
    return undefined
  }
}

// The configured control-plane URL wins; otherwise fall back to the URL the
// user signed in with, so pairing resolves through the hosted server.
export function resolvedControlPlaneUrl(): string | undefined {
  return readControlPlaneUrl() ?? readAuthSession()?.url
}

export function writeControlPlaneUrl(url: string | undefined): void {
  const file = controlPlaneFile()
  if (url === undefined) {
    rmSync(file, { force: true })
    return
  }
  writeSecretFile(file, JSON.stringify({ url }))
}

export function resolveJoinServer(
  input: string,
  controlPlaneUrl: string | undefined,
): { code: string; serverUrl?: string } {
  const direct = Pairing.parsePairingCode(input.trim())
  if (direct !== undefined) return direct
  const code = Pairing.normalizePairingCode(input.trim())
  if (code.length === 0) {
    throw new Error("That pairing code is not valid. Enter the 8-character code shown on the other computer.")
  }
  return { code, ...(controlPlaneUrl === undefined ? {} : { serverUrl: controlPlaneUrl }) }
}

function start(
  next: RemoteAgentConfig,
  options: {
    driver?: ReturnType<typeof createPlatformHostDriver>
    keys?: Remote.RemoteKeyPair
    browser?: Remote.RemoteBrowserHandler
  } = {},
): boolean {
  const driver = options.driver ?? createPlatformHostDriver()
  if (driver === undefined) return false
  // Resolve the bridge handler per call: registration can run before the
  // embedded browser bridge has started, and a missing bridge must fail
  // closed rather than silently dropping browser commands.
  const browser =
    options.browser ??
    ((command: Remote.RemoteBrowserCommand) => {
      if (remoteBrowserHandler === undefined) {
        return Promise.reject(new Error("The embedded browser bridge is not available on this computer."))
      }
      return remoteBrowserHandler(command)
    })
  // Wrap mutating driver calls so the halo ring paints and input freezes for
  // the whole native command; reads and browser commands stay unlocked.
  const tracked = withNativeActionTracking(driver)
  agent?.stop()
  if (activeDriver !== undefined && activeDriver !== tracked) activeDriver.dispose?.()
  activeDriver = tracked
  // The overlay's event source follows whichever runtime is registered now.
  bindActiveGrab()
  agent = new Remote.RemoteAgent({
    serverUrl: next.serverUrl,
    computerId: next.computerId,
    token: next.token,
    driver: tracked,
    browser,
    keyStorage: remoteKeyStorage(),
    ...(options.keys === undefined ? {} : { keys: options.keys }),
  })
  agent.start()
  return true
}

export function setRemoteBrowserHandler(handler: Remote.RemoteBrowserHandler | undefined): void {
  remoteBrowserHandler = handler
}

// Native (non-browser) command execution drives the halo ring and the input
// freeze through agent-working. Reads (observe/find/text/clipboard/pointer
// position) and embedded-browser commands never touch it.
export interface NativeActionObserver {
  started(): void
  ended(ok: boolean): void
}

let actionObserver: NativeActionObserver | undefined

export function setNativeActionObserver(observer: NativeActionObserver | undefined): void {
  actionObserver = observer
}

// The X11 grab helper reports user-driven releases (the double-Escape escape
// hatch) on this machine, without a control-plane round trip. agent-working
// subscribes here so the same `input.frozen` / `input.released` events the
// server publishes reach the overlay even while the control plane is
// unreachable, which is exactly when a stale freeze strands the user.
const grabListeners = new Map<(event: AgentActivityEvent) => void, (event: Daemon.InputGrabEvent) => void>()
let unsubscribeActiveGrab: (() => void) | undefined

function bindActiveGrab(): void {
  unsubscribeActiveGrab?.()
  unsubscribeActiveGrab = undefined
  const driver = activeDriver
  if (driver?.subscribeInputGrab === undefined) return
  unsubscribeActiveGrab = driver.subscribeInputGrab((event) => {
    for (const forward of grabListeners.values()) forward(event)
  })
}

export function agentEventSource(): { subscribe(listener: (event: AgentActivityEvent) => void): () => void } {
  return {
    subscribe(listener) {
      const forward = (event: Daemon.InputGrabEvent) => {
        listener({
          type: event.type === "frozen" ? "input.frozen" : "input.released",
          data: {
            ...(event.releasedBy === undefined ? {} : { releasedBy: event.releasedBy }),
            ...(event.reason === undefined ? {} : { reason: event.reason }),
          },
        })
      }
      grabListeners.set(listener, forward)
      // The runtime registers after the app wires the overlay, so bind on every
      // subscription; bindActiveGrab re-binds when a new runtime registers.
      bindActiveGrab()
      return () => {
        grabListeners.delete(listener)
        if (grabListeners.size > 0) return
        unsubscribeActiveGrab?.()
        unsubscribeActiveGrab = undefined
      }
    },
  }
}

type PlatformDriver = NonNullable<ReturnType<typeof createPlatformHostDriver>>

export function withNativeActionTracking(
  driver: PlatformDriver,
  observer: NativeActionObserver | undefined = actionObserver,
): PlatformDriver {
  if (observer === undefined) return driver
  const track = async <T extends { success: boolean }>(work: () => Promise<T>): Promise<T> => {
    observer.started()
    try {
      const result = await work()
      observer.ended(result.success)
      return result
    } catch (error) {
      observer.ended(false)
      throw error
    }
  }
  const runCommand = driver.runCommand
  const mouseDown = driver.mouseDown
  const mouseUp = driver.mouseUp
  const hoverPointer = driver.hoverPointer
  // Delegate rather than copy. Platform drivers are class instances: spreading
  // drops prototype methods (observe, find, ...), and rebuilding one with
  // Object.create skips the constructor, leaving its private fields
  // uninitialized. A proxy forwards everything else to the real driver.
  return new Proxy(driver, {
    get(target, property, receiver) {
      if (property === "execute")
        return (action: Parameters<PlatformDriver["execute"]>[0]) => track(() => target.execute(action))
      if (property === "runCommand") {
        return typeof runCommand === "function"
          ? (request: Parameters<NonNullable<typeof runCommand>>[0]) => track(() => runCommand.call(target, request))
          : runCommand
      }
      if (property === "mouseDown") {
        return typeof mouseDown === "function"
          ? (button?: number) => track(() => mouseDown.call(target, button))
          : mouseDown
      }
      if (property === "mouseUp") {
        return typeof mouseUp === "function" ? (button?: number) => track(() => mouseUp.call(target, button)) : mouseUp
      }
      if (property === "hoverPointer") {
        return typeof hoverPointer === "function"
          ? (x: number, y: number, holdMs?: number) => track(() => hoverPointer.call(target, x, y, holdMs))
          : hoverPointer
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
    has(target, property) {
      return Reflect.has(target, property)
    },
  })
}

interface BrowserParams {
  url?: string
  tabId?: string
  sessionId?: string
  key?: string
  query?: string
  username?: string
  password?: string
  text?: string
  value?: string
  accept?: boolean
  promptText?: string
  expectedType?: string
  expectedMessage?: string
  from?: { tabId?: string; sessionId?: string; id?: string; x?: number; y?: number }
  to?: { tabId?: string; sessionId?: string; id?: string; x?: number; y?: number }
  input?: { tabId?: string; sessionId?: string; deltaX?: number; deltaY?: number; x?: number; y?: number }
  options?: { offset?: number; limit?: number; maxChars?: number; role?: string; sessionId?: string }
  target?: {
    tabId?: string
    sessionId?: string
    id?: string
    x?: number
    y?: number
    text?: string
    url?: string
    query?: string
    path?: string
    filename?: string
    button?: "left" | "right" | "middle"
  }
  files?: string[]
}

export function createRemoteBrowserHandler(runtime: Browser.BrowserRuntime): Remote.RemoteBrowserHandler {
  return (command) => {
    const params = browserParams(command.params)
    switch (command.operation) {
      case "status":
        return runtime.status()
      case "open":
        return runtime.open(stringOrUndefined(params.url))
      case "tabs":
        return runtime.tabs()
      case "activate":
        return runtime.activate(requireString(params.tabId, "tab id"))
      case "closeTab":
        return runtime.closeTab(requireString(params.tabId, "tab id"))
      case "navigate":
        return runtime.navigate(
          requireString(params.url, "url"),
          stringOrUndefined(params.tabId),
          stringOrUndefined(params.sessionId),
        )
      case "read":
        return runtime.read(stringOrUndefined(params.tabId), params.options)
      case "screenshot":
        return runtime.screenshot(stringOrUndefined(params.tabId), stringOrUndefined(params.sessionId))
      case "find":
        return runtime.find(requireString(params.query, "query"), params.options)
      case "images":
        return runtime.images(stringOrUndefined(params.tabId), params.options)
      case "saveImage":
        return runtime.saveImage(browserTarget(params.target))
      case "upload": {
        if (params.files === undefined || params.files.length === 0) {
          return Promise.reject(new Error("The browser upload command needs files."))
        }
        return runtime.upload(params.files, stringOrUndefined(params.tabId), stringOrUndefined(params.sessionId))
      }
      case "click":
        return runtime.click(browserTarget(params.target))
      case "hover":
        return runtime.hover(browserTarget(params.target))
      case "select": {
        const target = browserTarget(params.target)
        return runtime.select(
          { ...target, id: requireString(target.id, "element id") },
          stringOrUndefined(params.value),
          stringOrUndefined(params.text),
        )
      }
      case "drag": {
        const from = browserTarget(params.from)
        const to = browserTarget(params.to)
        if (from.id === undefined && (from.x === undefined || from.y === undefined)) {
          return Promise.reject(new Error("The drag command needs a from element id or coordinates."))
        }
        if (to.id === undefined && (to.x === undefined || to.y === undefined)) {
          return Promise.reject(new Error("The drag command needs a to element id or coordinates."))
        }
        return runtime.drag(from, to)
      }
      case "scroll": {
        const input: NonNullable<BrowserParams["input"]> = params.input ?? {}
        return runtime.scroll({
          ...(stringOrUndefined(input.tabId) === undefined ? {} : { tabId: stringOrUndefined(input.tabId) }),
          ...(stringOrUndefined(input.sessionId) === undefined
            ? {}
            : { sessionId: stringOrUndefined(input.sessionId) }),
          ...(typeof input.deltaX === "number" ? { deltaX: input.deltaX } : {}),
          ...(typeof input.deltaY === "number" ? { deltaY: input.deltaY } : {}),
          ...(typeof input.x === "number" ? { x: input.x } : {}),
          ...(typeof input.y === "number" ? { y: input.y } : {}),
        })
      }
      case "scrollPosition": {
        const input: NonNullable<BrowserParams["input"]> = params.input ?? {}
        return runtime.scrollPosition({
          ...(stringOrUndefined(input.tabId) === undefined ? {} : { tabId: stringOrUndefined(input.tabId) }),
          ...(stringOrUndefined(input.sessionId) === undefined
            ? {}
            : { sessionId: stringOrUndefined(input.sessionId) }),
        })
      }
      case "type": {
        const target = browserTarget(params.target)
        return runtime.type({
          ...target,
          ...(target.id === undefined ? {} : { id: target.id }),
          text: stringOrUndefined(target.text) ?? "",
        })
      }
      case "readValue": {
        const target = browserTarget(params.target)
        return runtime.readValue({
          ...target,
          id: requireString(target.id, "element id"),
        })
      }
      case "key":
        return runtime.key(
          requireString(params.key, "key"),
          stringOrUndefined(params.tabId),
          stringOrUndefined(params.sessionId),
        )
      case "back":
        return runtime.back(stringOrUndefined(params.tabId), stringOrUndefined(params.sessionId))
      case "forward":
        return runtime.forward(stringOrUndefined(params.tabId), stringOrUndefined(params.sessionId))
      case "reload":
        return runtime.reload(stringOrUndefined(params.tabId), stringOrUndefined(params.sessionId))
      case "pendingDialog":
        return runtime.pendingDialog(stringOrUndefined(params.tabId), stringOrUndefined(params.sessionId))
      case "handleDialog": {
        const tabId = stringOrUndefined(params.tabId)
        const sessionId = stringOrUndefined(params.sessionId)
        return runtime.handleDialog({
          ...(tabId === undefined ? {} : { tabId }),
          ...(sessionId === undefined ? {} : { sessionId }),
          accept: params.accept === true,
          ...(typeof params.promptText === "string" ? { promptText: params.promptText } : {}),
          ...(typeof params.expectedType === "string" ? { expectedType: params.expectedType } : {}),
          ...(typeof params.expectedMessage === "string" ? { expectedMessage: params.expectedMessage } : {}),
        })
      }
      case "downloads":
        return runtime.downloads()
      case "authRequired":
        return runtime.authRequired()
      case "answerAuth":
        return runtime.answerAuth({
          username: requireString(params.username, "username"),
          password: typeof params.password === "string" ? params.password : "",
        })
      default:
        return Promise.reject(new Error(`Unsupported browser operation ${command.operation}.`))
    }
  }
}

function browserParams(value: unknown): BrowserParams {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return value as BrowserParams
}

function browserTarget(value: unknown): NonNullable<BrowserParams["target"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return value as NonNullable<BrowserParams["target"]>
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`The browser command needs a ${label}.`)
  return value
}

function authFingerprint(): string | undefined {
  const auth = controlPlaneAuth()
  if (auth === undefined) return undefined
  return `${auth.url}\n${auth.clientToken}`
}

// Only a 401 from an /v1/auth/* call can retire the stored session. Any other
// endpoint (registration, pairing) rejecting a request must leave the session
// alone, otherwise a transient 401 signs the user out mid-session.
function retireSessionOnUnauthorized(path: string, response: Response): boolean {
  if (response.status !== 401 || !path.startsWith("/v1/auth/")) return false
  rmSync(join(app.getPath("userData"), "auth-session.json"), { force: true })
  return true
}

function stopControlPlaneRuntime(): void {
  runtimeDriverUnregister?.()
  runtimeDriverUnregister = undefined
  controlPlane = undefined
  registeredFingerprint = undefined
  agent?.stop()
  agent = undefined
  activeDriver?.dispose?.()
  activeDriver = undefined
  bindActiveGrab()
}

// The thin client registers the local runtime as a remote computer on every
// launch and after sign-in. The returned computer token only lives in memory;
// the client token in the auth session is the durable credential.
export async function registerWithControlPlane(): Promise<{ computerId: string; serverUrl: string }> {
  const auth = controlPlaneAuth()
  if (auth === undefined) {
    throw new Error("Sign in to Omnia and configure the control plane before registering this computer.")
  }
  const driver = createPlatformHostDriver()
  if (driver === undefined) throw new Error("No computer runtime is available on this machine.")
  const keys = await Remote.loadOrCreateRemoteKeyPair(remoteKeyStorage())
  const info = await driver.getInfo()
  const reuseId = readRegisteredComputerId()
  const path = "/v1/computers/register"
  const response = await fetchControlPlane(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: hostname(),
      platform: info.platform,
      ...(info.architecture === undefined ? {} : { architecture: info.architecture }),
      info,
      capabilities: driver.capabilities ?? [],
      publicKey: keys.publicKey,
      ...(reuseId === undefined ? {} : { computerId: reuseId }),
    }),
  })
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean
    computerId?: string
    token?: string
    error?: string
  }
  if (!response.ok || body.ok !== true || typeof body.computerId !== "string" || typeof body.token !== "string") {
    driver.dispose?.()
    if (response.status === 401) {
      // Registration is not an auth call, so the stored session survives: a 401
      // here only rejects this request and the next sync tick retries it.
      if (retireSessionOnUnauthorized(path, response)) {
        throw new Error("The control-plane session expired; sign in with GitHub again.")
      }
      throw new Error("The control plane rejected this computer's registration. Sign in with GitHub again and retry.")
    }
    throw new Error(
      typeof body.error === "string" ? body.error : `Registering this computer failed with HTTP ${response.status}.`,
    )
  }
  stopControlPlaneRuntime()
  controlPlane = { computerId: body.computerId, serverUrl: auth.url }
  writeRegisteredComputerId(body.computerId)
  if (!start({ serverUrl: auth.url, computerId: body.computerId, token: body.token }, { driver, keys })) {
    controlPlane = undefined
    throw new Error("Registered with the control plane, but no computer runtime is available on this machine.")
  }
  // Expose the registered runtime to the UI (readiness, overlay, computer-use)
  // through the control plane instead of the removed local server.
  runtimeDriverUnregister?.()
  omniaDriverRegistry.clear()
  runtimeDriverUnregister = registerOmniaDriver(
    createControlPlaneDriver({ computerId: body.computerId, capabilities: driver.capabilities ?? [] }),
  )
  return controlPlane
}

export async function syncControlPlaneRegistration(): Promise<void> {
  if (config !== undefined) return
  const fingerprint = authFingerprint()
  if (fingerprint === undefined || fingerprint === suppressedFingerprint) {
    if (fingerprint === undefined) stopControlPlaneRuntime()
    return
  }
  // A control-plane restart (or revoked token) stops the remote agent; clear
  // the registration so the next tick registers again with the durable client
  // token and the persisted computer id.
  if (controlPlane !== undefined && agent?.running !== true) stopControlPlaneRuntime()
  if (fingerprint === registeredFingerprint || registering) return
  registering = true
  try {
    await registerWithControlPlane()
    registeredFingerprint = fingerprint
  } catch {
    registeredFingerprint = undefined
  } finally {
    registering = false
  }
}

export function registerRemoteAgentIpcHandlers(): void {
  config = loadRemoteAgentConfig()
  if (config !== undefined) {
    // Re-persist on load so plaintext tokens from older versions are encrypted.
    persistRemoteAgentConfig(config)
    start(config)
  } else {
    void syncControlPlaneRegistration()
    const timer = setInterval(() => void syncControlPlaneRegistration(), 5000)
    timer.unref?.()
    app.once("will-quit", () => clearInterval(timer))
  }

  ipcMain.handle("computers-control-plane-get", () => {
    return { url: resolvedControlPlaneUrl() ?? null }
  })

  ipcMain.handle("computers-control-plane-set", (_event, value: unknown) => {
    const raw = typeof value === "string" ? value.trim() : ""
    if (raw.length === 0) {
      writeControlPlaneUrl(undefined)
      void syncControlPlaneRegistration()
      return { url: resolvedControlPlaneUrl() ?? null }
    }
    const url = normalizeControlPlaneUrl(raw)
    writeControlPlaneUrl(url)
    void syncControlPlaneRegistration()
    return { url }
  })

  ipcMain.handle("computers-pair-join", async (_event, pairingCode: unknown) => {
    const request = resolveJoinServer(typeof pairingCode === "string" ? pairingCode : "", resolvedControlPlaneUrl())
    const serverUrl = request.serverUrl ?? (await Pairing.discoverPairingHost(request.code))
    if (serverUrl === undefined) {
      throw new Error(
        "No computer on this network is offering that pairing code. Keep the pairing dialog open on the other computer and try again.",
      )
    }
    const driver = createPlatformHostDriver()
    if (driver === undefined) throw new Error("No computer runtime is available on this machine.")
    const info = await driver.getInfo()
    const keys = await Remote.loadOrCreateRemoteKeyPair(remoteKeyStorage())
    const response = await fetch(`${serverUrl}/v1/computers/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: request.code,
        name: hostname(),
        platform: info.platform,
        ...(info.architecture === undefined ? {} : { architecture: info.architecture }),
        info,
        capabilities: driver.capabilities ?? [],
        publicKey: keys.publicKey,
      }),
    })
    // A proxy or an edge worker can answer a failed claim with an HTML error page,
    // so an unparsable body must fall through to the status branch below instead of
    // throwing a SyntaxError with the markup in it.
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      computerId?: string
      token?: string
      error?: string
    }
    if (!response.ok || body.ok !== true || typeof body.computerId !== "string" || typeof body.token !== "string") {
      throw new Error(body.error ?? `Pairing failed with HTTP ${response.status}.`)
    }
    stopControlPlaneRuntime()
    config = { serverUrl, computerId: body.computerId, token: body.token }
    persistRemoteAgentConfig(config)
    if (!start(config, { driver, keys })) {
      // The claim is already consumed, but the token is persisted above, so a
      // second code must never be needed: retry once with a fresh driver
      // before failing. A restart also resumes from the stored config.
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const retryDriver = createPlatformHostDriver()
      if (retryDriver !== undefined && start(config, { driver: retryDriver, keys })) {
        return { computerId: config.computerId, serverUrl: config.serverUrl, name: hostname() }
      }
      throw new Error("Paired, but the computer runtime did not start. Restart the app to resume the pairing.")
    }
    return { computerId: config.computerId, serverUrl: config.serverUrl, name: hostname() }
  })

  ipcMain.handle("computers-pair-leave", async () => {
    const current = config
    suppressedFingerprint = authFingerprint()
    agent?.stop()
    agent = undefined
    activeDriver?.dispose?.()
    activeDriver = undefined
    bindActiveGrab()
    config = undefined
    controlPlane = undefined
    registeredFingerprint = undefined
    persistRemoteAgentConfig(undefined)
    if (current !== undefined) {
      const keys = await Remote.loadOrCreateRemoteKeyPair(remoteKeyStorage())
      const url = `${current.serverUrl}/v1/computers/${current.computerId}/remote/bye`
      const headers = Remote.remoteAuthHeaders({
        token: current.token,
        computerId: current.computerId,
        method: "POST",
        url,
        baseUrl: current.serverUrl,
        timestampMs: Date.now(),
        keys: keys.privateKey,
      })
      await fetch(url, { method: "POST", headers }).catch(() => undefined)
    }
    return true
  })

  ipcMain.handle("computers-pair-status", () => {
    if (config !== undefined) {
      return {
        paired: true,
        computerId: config.computerId,
        serverUrl: config.serverUrl,
        connected: agent?.running === true,
      }
    }
    if (controlPlane !== undefined) {
      return {
        paired: true,
        computerId: controlPlane.computerId,
        serverUrl: controlPlane.serverUrl,
        connected: agent?.running === true,
      }
    }
    return { paired: false }
  })
}
