import type {
  BackendId,
  Bounds,
  ComputerInfo,
  Observation,
  ObservationRequest,
  PermissionScope,
  ProtocolActionResult,
  ProtocolCapabilityState,
  ProtocolComputerAction,
  ProtocolComputerDriver,
  ProtocolComputerInfo,
  ProtocolObservation,
  ProtocolUIElement,
  Screenshot,
} from "../protocol"

type ProtocolCapabilityList = NonNullable<ComputerInfo["capabilities"]>
type ProtocolCapabilitySupport = ProtocolCapabilityList[number]
type ProtocolPermissionList = NonNullable<ProtocolCapabilitySupport["permissions"]>
type ProtocolPermissionRequirement = ProtocolPermissionList[number]
type ProtocolLimitationList = NonNullable<ProtocolCapabilitySupport["limitations"]>
type ProtocolLimitation = ProtocolLimitationList[number]

export const COMPUTER_PLATFORMS = ["macos", "windows", "linux", "web", "browser", "future", "unknown"] as const
export type KnownComputerPlatform = (typeof COMPUTER_PLATFORMS)[number]
export const PLATFORM_IDS = {
  macos: "macos",
  windows: "windows",
  linux: "linux",
  browser: "browser",
  future: "future",
} as const
export type ComputerPlatform = KnownComputerPlatform | (string & {})
export type Platform = ComputerPlatform
export type OperatingSystem = ComputerPlatform

export const DISPLAY_SERVERS = ["cocoa", "windows", "x11", "xwayland", "wayland", "browser", "unknown"] as const
export type DisplayServer = (typeof DISPLAY_SERVERS)[number]

export const BACKEND_KINDS = ["native", "browser", "remote", "virtual", "future", "unknown"] as const
export type BackendKind = (typeof BACKEND_KINDS)[number]

export const BACKEND_IDS = {
  macosAx: "macos-ax",
  macosAX: "macos-ax",
  windowsUia: "windows-uia",
  windowsUIA: "windows-uia",
  linuxAtSpi: "linux-at-spi",
  linuxATSPI: "linux-at-spi",
  browser: "browser",
  browserDOM: "browser",
  browserDom: "browser",
  future: "future",
} as const
export type KnownBackendId = (typeof BACKEND_IDS)[keyof typeof BACKEND_IDS]

export const CAPABILITIES = [
  "application-discovery",
  "application-focus",
  "accessibility",
  "accessibility-tree",
  "direct_ui_control",
  "target_lookup",
  "window-discovery",
  "window-management",
  "observe",
  "screenshot",
  "screen-read",
  "screen_read",
  "screen-capture",
  "pointer",
  "mouse",
  "keyboard",
  "text-input",
  "scroll",
  "drag-and-drop",
  "clipboard-read",
  "clipboard-write",
  "browser-navigation",
  "browser-semantic-tree",
  "browser-dom",
  "multi-monitor",
  "permission-prompt",
  "launch",
  "focus",
  "wait",
  "find",
  "activate",
  "click",
  "double-click",
  "right-click",
  "drag",
  "type",
  "keypress",
  "navigate",
  "read",
  "toggle",
] as const
export type KnownCapability = (typeof CAPABILITIES)[number]
export type Capability = string

export const CAPABILITY_ALIASES: Readonly<Record<string, string>> = {
  activate: "application-focus",
  click: "mouse",
  "double-click": "mouse",
  doubleclick: "mouse",
  "right-click": "mouse",
  rightclick: "mouse",
  drag: "drag-and-drop",
  find: "accessibility-tree",
  read: "accessibility-tree",
  key: "keyboard",
  keypress: "keyboard",
  navigate: "browser-navigation",
  paste: "text-input",
  type: "text-input",
  toggle: "application-focus",
}

export function resolveCapability(capability: string) {
  return CAPABILITY_ALIASES[capability] ?? capability
}

export const CAPABILITY_STATUSES = ["available", "degraded", "partial", "unavailable", "unknown"] as const
export type CapabilityStatus = ProtocolCapabilityState | "partial"

export const PROFILE_STATUSES = ["ready", "partial", "degraded", "unavailable"] as const
export type ProfileStatus = (typeof PROFILE_STATUSES)[number]

export const PERMISSION_STATUSES = ["granted", "denied", "prompt", "restricted", "not-required", "unknown"] as const
export type PermissionStatus = ProtocolPermissionRequirement["status"]

export const LIMITATION_SEVERITIES = ["info", "warning", "error"] as const
export type LimitationSeverity = ProtocolLimitation["severity"]

export const APPLICATION_KINDS = ["native", "browser", "webview", "unknown"] as const
export type ApplicationKind = (typeof APPLICATION_KINDS)[number]

export type QualityScore = {
  readonly overall: number
  readonly coverage: number
  readonly reliability: number
  readonly fidelity: number
  readonly responsiveness: number
  readonly permissionReadiness: number
}

export type PermissionRequirement = ProtocolPermissionRequirement & {
  readonly capabilities?: readonly Capability[]
  readonly promptable?: boolean
  readonly scope?: PermissionScope
}

export type Limitation = ProtocolLimitation

export type CapabilitySupport = Omit<ProtocolCapabilitySupport, "status" | "score" | "permissions" | "limitations"> & {
  readonly status: CapabilityStatus
  readonly score: number
  readonly permissions: readonly PermissionRequirement[]
  readonly limitations: readonly Limitation[]
}

export type BackendDescriptor = {
  readonly id: BackendId
  readonly name: string
  readonly platform: ComputerPlatform
  readonly kind: BackendKind
  readonly displayServers: readonly DisplayServer[]
  readonly priority: number
  readonly experimental: boolean
  readonly requiresPermission: boolean
  readonly responsiveness: number
  readonly metadata: Readonly<Record<string, string>>
}

export type CapabilityProfile = {
  readonly backend: BackendDescriptor
  readonly status: ProfileStatus
  readonly capabilities: Readonly<Record<string, CapabilitySupport>>
  readonly permissions: readonly PermissionRequirement[]
  readonly limitations: readonly Limitation[]
  readonly quality: QualityScore
  readonly displayServer?: DisplayServer
  readonly observedAt?: number
}

export type ApplicationProfile = {
  readonly id: string
  readonly applicationId?: string
  readonly name: string
  readonly kind: ApplicationKind
  readonly backend: BackendId
  readonly status: ProfileStatus
  readonly capabilities: Readonly<Record<string, CapabilitySupport>>
  readonly permissions: readonly PermissionRequirement[]
  readonly limitations: readonly Limitation[]
  readonly quality: QualityScore
  readonly displayServer?: DisplayServer
  readonly processName?: string
  readonly bundleID?: string
  readonly bundleId?: string
  readonly metadata: Readonly<Record<string, string>>
}

export type DiscoveryOptions = {
  readonly signal?: AbortSignal
  readonly applicationId?: string
  readonly includeUnavailable?: boolean
}

export type ApplicationQuery = {
  readonly applicationId?: string
  readonly name?: string
  readonly kind?: ApplicationKind
  readonly signal?: AbortSignal
}

export type ExecutionOptions = {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export type Region = Bounds
export type MouseButton = "left" | "right" | "middle"
export type Modifier = "alt" | "control" | "meta" | "shift"
export type ComputerCommand = ProtocolComputerAction
export type ScreenshotInfo = Screenshot
export type ComputerObservation = ProtocolObservation
export type ComputerResult = ProtocolActionResult
export type Element = ProtocolUIElement

export type {
  ActionResult,
  BackendId,
  Bounds,
  CapabilityState,
  ComputerAction,
  ComputerInfo,
  ComputerProvider,
  ComputerTarget,
  FindRequest,
  FindResult,
  Observation,
  ObservationRequest,
  PermissionScope,
  Screenshot,
  UIElement,
} from "../protocol"

export type CapabilityDiscovery = {
  readonly profile: CapabilityProfile
  readonly applications: readonly ApplicationProfile[]
  readonly limitations: readonly Limitation[]
  readonly observedAt: number
}

export type AdapterCreateOptions = {
  readonly signal?: AbortSignal
  readonly metadata?: Readonly<Record<string, string>>
}

export interface PlatformComputerDriver {
  readonly id: string
  readonly backend: BackendId
  readonly descriptor: BackendDescriptor
  readonly platform: ComputerPlatform
  discover(options?: DiscoveryOptions): Promise<CapabilityDiscovery>
  getCapabilities(options?: DiscoveryOptions): Promise<CapabilityProfile>
  listApplications(options?: ApplicationQuery): Promise<readonly ApplicationProfile[]>
  observe(request?: ObservationRequest): Promise<Observation>
  execute(action: ComputerCommand, options?: ExecutionOptions): Promise<ComputerResult>
  close?(): Promise<void> | void
}

export type ComputerDriver = PlatformComputerDriver & ProtocolComputerDriver
export type ProtocolDriver = ProtocolComputerDriver

export type ComputerAdapterFactory = (options?: AdapterCreateOptions) => Promise<ComputerDriver> | ComputerDriver

export interface ComputerAdapter {
  readonly descriptor: BackendDescriptor
  readonly createDriver?: ComputerAdapterFactory
  readonly create?: ComputerAdapterFactory
  readonly driver?: ComputerDriver
}

export type AdapterRegistration = ComputerAdapter
export type ComputerBackend = BackendDescriptor
export type ComputerCapability = Capability
export type ApplicationCapabilityProfile = ApplicationProfile
export type PlatformCapabilityProfile = CapabilityProfile

export function normalizeComputerPlatform(value: string): ComputerPlatform {
  const normalized = value.trim().toLowerCase()
  if (normalized === "darwin" || normalized === "mac" || normalized === "macos") return "macos"
  if (normalized === "win32" || normalized === "win" || normalized === "windows") return "windows"
  if (normalized === "web" || normalized === "browser") return "browser"
  if (normalized === "linux" || normalized === "freebsd") return "linux"
  return value
}

export function normalizeDisplayServer(value: string): DisplayServer {
  const normalized = value.trim().toLowerCase()
  if (normalized === "xwayland") return "wayland"
  if (
    normalized === "x11" ||
    normalized === "wayland" ||
    normalized === "cocoa" ||
    normalized === "windows" ||
    normalized === "browser"
  )
    return normalized
  return "unknown"
}

export function toProtocolCapabilityStatus(status: CapabilityStatus): ProtocolCapabilityState {
  return status === "partial" ? "degraded" : status
}

export function toProtocolCapabilitySupport(support: CapabilitySupport): ProtocolCapabilitySupport {
  return {
    capability: support.capability,
    status: toProtocolCapabilityStatus(support.status),
    score: support.score,
    reason: support.reason,
    permissions: support.permissions,
    limitations: support.limitations,
  }
}

export function toProtocolCapabilities(profile: CapabilityProfile): readonly ProtocolCapabilitySupport[] {
  return Object.values(profile.capabilities).map(toProtocolCapabilitySupport)
}

export function toProtocolComputerInfo(profile: CapabilityProfile): ProtocolComputerInfo {
  return {
    id: profile.backend.id,
    name: profile.backend.name,
    platform: profile.backend.platform,
    backend: profile.backend.id,
    connected: profile.status !== "unavailable",
    capabilities: toProtocolCapabilities(profile),
    metadata: {
      ...profile.backend.metadata,
      profileStatus: profile.status,
      limitations: profile.limitations.map((limitation) => ({
        code: limitation.code,
        kind: limitation.kind,
        severity: limitation.severity,
        message: limitation.message,
        ...(limitation.affects ? { affects: limitation.affects } : {}),
      })),
    },
  }
}
