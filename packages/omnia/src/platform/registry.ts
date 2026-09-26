import {
  BACKEND_IDS,
  type AdapterCreateOptions,
  type ApplicationProfile,
  type BackendDescriptor,
  type CapabilityDiscovery,
  type CapabilityProfile,
  type ComputerAdapter,
  type ComputerCommand,
  type ComputerDriver,
  type ComputerResult,
  type DiscoveryOptions,
  type ExecutionOptions,
  type Limitation,
  type PermissionRequirement,
  type ProtocolDriver,
} from "./contracts"
import {
  createCapabilityProfileFromReport,
  createUnavailableCapabilityProfile,
  filterApplicationProfiles,
} from "./capabilities"

export type AdapterRegistryOptions = {
  readonly adapters?: readonly ComputerAdapter[]
  readonly onError?: (error: unknown, adapter: ComputerAdapter) => void
}

export type AdapterDiscovery = {
  readonly adapter: ComputerAdapter
  readonly profile: CapabilityProfile
  readonly applications: readonly ApplicationProfile[]
  readonly limitations: readonly Limitation[]
  readonly error?: unknown
}

function descriptor(input: {
  readonly id: string
  readonly name: string
  readonly platform: BackendDescriptor["platform"]
  readonly kind: BackendDescriptor["kind"]
  readonly displayServers: readonly BackendDescriptor["displayServers"][number][]
  readonly priority?: number
  readonly experimental?: boolean
  readonly requiresPermission?: boolean
  readonly responsiveness?: number
  readonly metadata?: Readonly<Record<string, string>>
}): BackendDescriptor {
  return {
    id: input.id,
    name: input.name,
    platform: input.platform,
    kind: input.kind,
    displayServers: input.displayServers,
    priority: input.priority ?? 0,
    experimental: input.experimental ?? false,
    requiresPermission: input.requiresPermission ?? true,
    responsiveness: input.responsiveness ?? 0.5,
    metadata: input.metadata ?? {},
  }
}

function createAdapterDriver(adapter: ComputerAdapter, options?: AdapterCreateOptions) {
  if (adapter.driver) return adapter.driver
  const factory = adapter.createDriver ?? adapter.create
  if (!factory) throw new TypeError(`Computer adapter ${adapter.descriptor.id} has no driver factory.`)
  return factory(options)
}

export function createUnavailableDriver(input: {
  readonly backend: BackendDescriptor
  readonly reason: string
  readonly displayServer?: CapabilityProfile["displayServer"]
  readonly limitations?: readonly Limitation[]
  readonly permissions?: readonly PermissionRequirement[]
}): ComputerDriver {
  const profile = createUnavailableCapabilityProfile({
    backend: input.backend,
    reason: input.reason,
    displayServer: input.displayServer,
    limitations: input.limitations,
    permissions: input.permissions,
  })
  const applications: readonly ApplicationProfile[] = []
  return {
    id: input.backend.id,
    backend: input.backend.id,
    descriptor: input.backend,
    platform: input.backend.platform,
    discover: async (): Promise<CapabilityDiscovery> => ({
      profile,
      applications,
      limitations: profile.limitations,
      observedAt: Date.now(),
    }),
    getCapabilities: async () => profile,
    listApplications: async () => applications,
    observe: async () => ({
      timestamp: Date.now(),
      elements: [],
      source: "native",
      backend: input.backend.id,
      warnings: [input.reason],
      metadata: { unavailable: true, reason: input.reason },
    }),
    execute: async (_command: ComputerCommand, _options?: ExecutionOptions): Promise<ComputerResult> => ({
      success: false,
      status: "unavailable",
      message: input.reason,
      limitations: profile.limitations,
      metadata: { unavailable: true, reason: input.reason },
    }),
  }
}

export function createUnavailableAdapter(input: {
  readonly backend: BackendDescriptor
  readonly reason: string
  readonly displayServer?: CapabilityProfile["displayServer"]
  readonly limitations?: readonly Limitation[]
  readonly permissions?: readonly PermissionRequirement[]
}): ComputerAdapter {
  const driver = createUnavailableDriver(input)
  return {
    descriptor: input.backend,
    createDriver: (_options?: AdapterCreateOptions) => driver,
  }
}

export function createAdapterFromProtocolDriver(input: {
  readonly backend: BackendDescriptor
  readonly driver: ProtocolDriver
  readonly profile?: CapabilityProfile
  readonly reason?: string
}): ComputerAdapter {
  const reason = input.reason ?? "The protocol driver does not expose a capability profile."
  const profile =
    input.profile ??
    (input.driver.capabilities?.length
      ? createCapabilityProfileFromReport({
          backend: input.backend,
          capabilities: input.driver.capabilities,
          displayServer: input.backend.displayServers[0],
        })
      : createUnavailableCapabilityProfile({
          backend: input.backend,
          reason,
          displayServer: input.backend.displayServers[0],
        }))
  const applications: readonly ApplicationProfile[] = []
  const driver: ComputerDriver = {
    ...input.driver,
    id: input.driver.id,
    backend: input.driver.backend,
    descriptor: input.backend,
    platform: input.backend.platform,
    discover: async () => ({
      profile,
      applications,
      limitations: profile.limitations,
      observedAt: Date.now(),
    }),
    getCapabilities: async () => profile,
    listApplications: async () => applications,
    observe:
      input.driver.observe ??
      (async () => ({
        timestamp: Date.now(),
        elements: [],
        source: input.backend.kind,
        backend: input.backend.id,
        warnings: [reason],
        metadata: { unavailable: true, reason },
      })),
    execute:
      input.driver.execute ??
      (async () => ({
        success: false,
        status: "unavailable",
        message: reason,
        limitations: profile.limitations,
        metadata: { unavailable: true, reason },
      })),
  }
  return {
    descriptor: input.backend,
    createDriver: () => driver,
  }
}

export const adaptProtocolDriver = createAdapterFromProtocolDriver

export class AdapterRegistry {
  private readonly adapters = new Map<string, ComputerAdapter>()
  private readonly onError?: (error: unknown, adapter: ComputerAdapter) => void

  constructor(options: AdapterRegistryOptions = {}) {
    this.onError = options.onError
    options.adapters?.forEach((adapter) => this.register(adapter))
  }

  register(adapter: ComputerAdapter, options: { readonly replace?: boolean } = {}) {
    if (!options.replace && this.adapters.has(adapter.descriptor.id)) {
      throw new Error(`A computer adapter with id ${adapter.descriptor.id} is already registered.`)
    }
    this.adapters.set(adapter.descriptor.id, adapter)
    return this
  }

  registerDriver(driver: ComputerDriver, options: { readonly replace?: boolean } = {}) {
    return this.register({ descriptor: driver.descriptor, createDriver: () => driver }, options)
  }

  registerProtocolDriver(
    backend: BackendDescriptor,
    driver: ProtocolDriver,
    options: { readonly replace?: boolean; readonly profile?: CapabilityProfile; readonly reason?: string } = {},
  ) {
    return this.register(
      createAdapterFromProtocolDriver({
        backend,
        driver,
        profile: options.profile,
        reason: options.reason,
      }),
      options,
    )
  }

  unregister(id: string) {
    return this.adapters.delete(id)
  }

  has(id: string) {
    return this.adapters.has(id)
  }

  get(id: string) {
    return this.adapters.get(id)
  }

  getAdapter(id: string) {
    return this.get(id)
  }

  list() {
    return [...this.adapters.values()].sort(
      (left, right) =>
        right.descriptor.priority - left.descriptor.priority || left.descriptor.id.localeCompare(right.descriptor.id),
    )
  }

  listAdapters() {
    return this.list()
  }

  clear() {
    this.adapters.clear()
    return this
  }

  async createDriver(id: string, options?: AdapterCreateOptions) {
    const adapter = this.adapters.get(id)
    if (!adapter) throw new Error(`No computer adapter with id ${id} is registered.`)
    return createAdapterDriver(adapter, options)
  }

  async discover(options: DiscoveryOptions = {}): Promise<readonly AdapterDiscovery[]> {
    const results = await Promise.all(
      this.list().map(async (adapter) => {
        let driver: ComputerDriver | undefined
        try {
          driver = await createAdapterDriver(adapter, { signal: options.signal })
          const discovery = await driver.discover(options)
          const applications = discovery.applications.length
            ? discovery.applications
            : await driver.listApplications(options)
          return {
            adapter,
            profile: discovery.profile,
            applications,
            limitations: discovery.limitations,
          }
        } catch (error) {
          this.onError?.(error, adapter)
          const profile = createUnavailableCapabilityProfile({
            backend: adapter.descriptor,
            reason: "Adapter discovery failed.",
          })
          return {
            adapter,
            profile,
            applications: [],
            limitations: profile.limitations,
            error,
          }
        } finally {
          try {
            await driver?.close?.()
          } catch (error) {
            this.onError?.(error, adapter)
          }
        }
      }),
    )
    return results.filter((result) => options.includeUnavailable !== false || result.profile.status !== "unavailable")
  }

  async discoverCapabilities(options: DiscoveryOptions = {}) {
    return (await this.discover(options)).map((result) => result.profile)
  }

  async listApplications(options: DiscoveryOptions = {}) {
    const discoveries = await this.discover({ ...options, includeUnavailable: true })
    return filterApplicationProfiles(
      discoveries.flatMap((discovery) => discovery.applications),
      options,
    )
  }
}

export function defineAdapter(adapter: ComputerAdapter) {
  return adapter
}

export const defineComputerAdapter = defineAdapter

export function createAdapterRegistry(options?: AdapterRegistryOptions) {
  return new AdapterRegistry(options)
}

export function registerAdapter(
  registry: AdapterRegistry,
  adapter: ComputerAdapter,
  options?: { readonly replace?: boolean },
): AdapterRegistry
export function registerAdapter(adapter: ComputerAdapter, options?: { readonly replace?: boolean }): AdapterRegistry
export function registerAdapter(
  registryOrAdapter: AdapterRegistry | ComputerAdapter,
  adapterOrOptions?: ComputerAdapter | { readonly replace?: boolean },
  options: { readonly replace?: boolean } = {},
): AdapterRegistry {
  if (registryOrAdapter instanceof AdapterRegistry) {
    if (!adapterOrOptions || !("descriptor" in adapterOrOptions)) {
      throw new TypeError("An adapter is required.")
    }
    return registryOrAdapter.register(adapterOrOptions, options)
  }
  const replace = adapterOrOptions && "replace" in adapterOrOptions ? adapterOrOptions.replace : undefined
  return defaultAdapterRegistry.register(registryOrAdapter, { replace })
}

export function getRegisteredAdapter(id: string) {
  return defaultAdapterRegistry.get(id)
}

export function listRegisteredAdapters() {
  return defaultAdapterRegistry.list()
}

export const getAdapter = getRegisteredAdapter
export const listAdapters = listRegisteredAdapters

export function unregisterRegisteredAdapter(id: string) {
  return defaultAdapterRegistry.unregister(id)
}

export function discoverAdapters(options: DiscoveryOptions = {}) {
  return defaultAdapterRegistry.discover(options)
}

function isBackendDescriptor(value: unknown): value is BackendDescriptor {
  return (
    typeof value === "object" && value !== null && "platform" in value && "kind" in value && "displayServers" in value
  )
}

function isProtocolDriver(value: unknown): value is ProtocolDriver {
  return typeof value === "object" && value !== null && "backend" in value && "id" in value
}

function isRegistrationOptions(
  value: unknown,
): value is { readonly replace?: boolean; readonly profile?: CapabilityProfile; readonly reason?: string } {
  return typeof value === "object" && value !== null && !("id" in value)
}

export function registerProtocolDriver(
  registry: AdapterRegistry,
  backend: BackendDescriptor,
  driver: ProtocolDriver,
  options?: { readonly replace?: boolean; readonly profile?: CapabilityProfile; readonly reason?: string },
): AdapterRegistry
export function registerProtocolDriver(
  backend: BackendDescriptor,
  driver: ProtocolDriver,
  options?: { readonly replace?: boolean; readonly profile?: CapabilityProfile; readonly reason?: string },
): AdapterRegistry
export function registerProtocolDriver(
  registryOrBackend: AdapterRegistry | BackendDescriptor,
  backendOrDriver: BackendDescriptor | ProtocolDriver,
  driverOrOptions?:
    | ProtocolDriver
    | { readonly replace?: boolean; readonly profile?: CapabilityProfile; readonly reason?: string },
  options: { readonly replace?: boolean; readonly profile?: CapabilityProfile; readonly reason?: string } = {},
): AdapterRegistry {
  if (registryOrBackend instanceof AdapterRegistry) {
    if (!isBackendDescriptor(backendOrDriver) || !isProtocolDriver(driverOrOptions))
      throw new TypeError("A protocol driver is required.")
    return registryOrBackend.registerProtocolDriver(backendOrDriver, driverOrOptions, options)
  }
  if (!isBackendDescriptor(registryOrBackend) || !isProtocolDriver(backendOrDriver))
    throw new TypeError("A backend descriptor and protocol driver are required.")
  const driverOptions = isRegistrationOptions(driverOrOptions) ? driverOrOptions : options
  return defaultAdapterRegistry.registerProtocolDriver(registryOrBackend, backendOrDriver, driverOptions)
}

export const MACOS_AX_BACKEND = descriptor({
  id: BACKEND_IDS.macosAx,
  name: "macOS Accessibility",
  platform: "macos",
  kind: "native",
  displayServers: ["cocoa"],
  priority: 100,
  responsiveness: 0.9,
  metadata: { contract: "accessibility", api: "AX" },
})

export const WINDOWS_UIA_BACKEND = descriptor({
  id: BACKEND_IDS.windowsUia,
  name: "Windows UI Automation",
  platform: "windows",
  kind: "native",
  displayServers: ["windows"],
  priority: 100,
  responsiveness: 0.9,
  metadata: { contract: "accessibility", api: "UIA" },
})

export const LINUX_AT_SPI_BACKEND = descriptor({
  id: BACKEND_IDS.linuxAtSpi,
  name: "Linux AT-SPI",
  platform: "linux",
  kind: "native",
  displayServers: ["x11", "wayland"],
  priority: 90,
  responsiveness: 0.75,
  metadata: { contract: "accessibility", api: "AT-SPI" },
})

export const BROWSER_BACKEND = descriptor({
  id: BACKEND_IDS.browser,
  name: "Browser DOM",
  platform: "browser",
  kind: "browser",
  displayServers: ["browser"],
  priority: 80,
  responsiveness: 0.95,
  requiresPermission: false,
  metadata: { contract: "dom", api: "DOM" },
})

export const FUTURE_BACKEND = descriptor({
  id: BACKEND_IDS.future,
  name: "Future Computer Backend",
  platform: "future",
  kind: "future",
  displayServers: ["unknown"],
  priority: 0,
  experimental: true,
  responsiveness: 0.5,
  metadata: { contract: "extension" },
})

export const MACOS_PERMISSION_REQUIREMENTS: readonly PermissionRequirement[] = [
  {
    id: "accessibility",
    description: "The host must grant accessibility access to the driver identity.",
    status: "unknown",
    capabilities: ["accessibility", "accessibility-tree", "application-focus"],
    promptable: true,
  },
  {
    id: "screen-recording",
    description: "The host must grant screen recording access to the driver identity.",
    status: "unknown",
    capabilities: ["screenshot", "screen-capture", "screen-read"],
    promptable: true,
  },
]

export const WINDOWS_PERMISSION_REQUIREMENTS: readonly PermissionRequirement[] = [
  {
    id: "interactive-session",
    description: "The driver must run in the interactive desktop session.",
    status: "unknown",
    capabilities: ["accessibility", "window-discovery", "window-management"],
    promptable: false,
  },
]

export const LINUX_PERMISSION_REQUIREMENTS: readonly PermissionRequirement[] = [
  {
    id: "accessibility-bus",
    description: "The host must expose the accessibility bus to the driver.",
    status: "unknown",
    capabilities: ["accessibility", "accessibility-tree"],
    promptable: false,
  },
]

export const macOSAXAdapter = createUnavailableAdapter({
  backend: MACOS_AX_BACKEND,
  reason: "The macOS AX adapter requires a host-provided Accessibility implementation.",
  permissions: MACOS_PERMISSION_REQUIREMENTS,
})

export const windowsUIAAdapter = createUnavailableAdapter({
  backend: WINDOWS_UIA_BACKEND,
  reason: "The Windows UIA adapter requires a host-provided UI Automation implementation.",
  permissions: WINDOWS_PERMISSION_REQUIREMENTS,
})

export const linuxATSPIAdapter = createUnavailableAdapter({
  backend: LINUX_AT_SPI_BACKEND,
  reason: "The Linux AT-SPI adapter requires a host-provided accessibility implementation.",
  permissions: LINUX_PERMISSION_REQUIREMENTS,
})

export const browserAdapter = createUnavailableAdapter({
  backend: BROWSER_BACKEND,
  reason: "The browser adapter requires a host-provided browser bridge.",
})

export const futureAdapter = createUnavailableAdapter({
  backend: FUTURE_BACKEND,
  reason: "No future computer backend has been registered.",
})

export const macOsAxAdapter = macOSAXAdapter
export const windowsUiaAdapter = windowsUIAAdapter
export const linuxAtSpiAdapter = linuxATSPIAdapter
export const macosAxAdapter = macOSAXAdapter
export const windowsUiaBackendAdapter = windowsUIAAdapter
export const linuxAtSpiBackendAdapter = linuxATSPIAdapter
export const browserDomAdapter = browserAdapter
export const MacOSAXAdapter = macOSAXAdapter
export const WindowsUIAAdapter = windowsUIAAdapter
export const LinuxATSPIAdapter = linuxATSPIAdapter
export const BrowserAdapter = browserAdapter
export const FutureAdapter = futureAdapter

export const MACOS_AX = MACOS_AX_BACKEND
export const WINDOWS_UIA = WINDOWS_UIA_BACKEND
export const LINUX_AT_SPI = LINUX_AT_SPI_BACKEND
export const BROWSER_DOM = BROWSER_BACKEND
export const AX_BACKEND = MACOS_AX_BACKEND
export const UIA_BACKEND = WINDOWS_UIA_BACKEND
export const ATSPI_BACKEND = LINUX_AT_SPI_BACKEND

export const createMacOSAXAdapter = () => macOSAXAdapter
export const createWindowsUIAAdapter = () => windowsUIAAdapter
export const createLinuxATSPIAdapter = () => linuxATSPIAdapter
export const createBrowserAdapter = () => browserAdapter
export const createFutureAdapter = () => futureAdapter

export const DEFAULT_COMPUTER_ADAPTERS = [
  macOSAXAdapter,
  windowsUIAAdapter,
  linuxATSPIAdapter,
  browserAdapter,
  futureAdapter,
] as const

export async function discoverAdapter(adapter: ComputerAdapter, options: DiscoveryOptions = {}) {
  const driver = await createAdapterDriver(adapter, { signal: options.signal })
  try {
    return await driver.discover(options)
  } finally {
    await driver.close?.()
  }
}

export function discoverMacOSAX(options?: DiscoveryOptions) {
  return discoverAdapter(macOSAXAdapter, options)
}

export function discoverWindowsUIA(options?: DiscoveryOptions) {
  return discoverAdapter(windowsUIAAdapter, options)
}

export function discoverLinuxATSPI(options?: DiscoveryOptions) {
  return discoverAdapter(linuxATSPIAdapter, options)
}

export function discoverBrowser(options?: DiscoveryOptions) {
  return discoverAdapter(browserAdapter, options)
}

export function discoverFuture(options?: DiscoveryOptions) {
  return discoverAdapter(futureAdapter, options)
}

export function discoverCapabilities(registry: AdapterRegistry, options: DiscoveryOptions = {}) {
  return registry.discoverCapabilities(options)
}

export function discoverApplications(registry: AdapterRegistry, options: DiscoveryOptions = {}) {
  return registry.listApplications(options)
}

export function createDefaultAdapterRegistry() {
  return new AdapterRegistry({ adapters: DEFAULT_COMPUTER_ADAPTERS })
}

export const defaultAdapterRegistry = createDefaultAdapterRegistry()
export const ComputerAdapterRegistry = AdapterRegistry
export const DriverRegistry = AdapterRegistry
