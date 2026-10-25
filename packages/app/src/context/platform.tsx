import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import type { DesktopMenuAction } from "../desktop-menu"
import { ServerConnection } from "./server"
import type { WslServersPlatform } from "../wsl/types"
import type { UpdaterPlatform } from "../updater"
import type { DraftStore } from "@/utils/draft-store"
import type { SuperskillPlatform } from "@/superskills"
import type { MemoryPlatform } from "@/memory"
import type { ComputerPlatform } from "@/computers"
import type { ChatPlatform } from "@/chat"
import type { ComputerUsePlatform } from "@/computer-use"

export type AuthProvider = "github" | "google"

export type GitHubProfile = {
  // GitHub ids are numeric; Google subjects are decimal strings wider than a
  // safe integer, so the id is text when it has to be.
  id: number | string
  login: string
  provider?: AuthProvider
  name?: string
  avatarUrl?: string
  email?: string
  htmlUrl?: string
}

export type GitHubAuthStatus = {
  authenticated: boolean
  profile?: GitHubProfile
  /** How the credential was minted; absent on sessions written before it was recorded. */
  method?: "oauth" | "gh" | "enterprise"
  controlPlaneUrl?: string
  /** This build is bound to an organization's control plane. */
  enterprise?: boolean
}

/** The organization the tenant profile belongs to. */
export type EnterpriseOrg = {
  name: string
  slug: string
}

export type EnterpriseBranding = {
  productName?: string
  shortName?: string
  tagline?: string
  primaryColor?: string
  accentColor?: string
  signInHeadline?: string
  signInSubheadline?: string
  logoUrl?: string
  iconUrl?: string
  supportUrl?: string
  docsUrl?: string
  footerText?: string
  showOmniaBranding?: boolean
}

export type EnterpriseAuthPolicy = {
  mode?: string
  methods?: string[]
  sessionHours?: number
  requireMfa?: boolean
  allowedEmailDomains?: string[]
  allowSocialLogin?: boolean
}

export type EnterpriseExperience = {
  theme?: string
  density?: string
  locale?: string
  homeSurface?: string
  defaultMode?: string
  instructions?: string
  showTips?: boolean
  showUsageMeter?: boolean
}

export type EnterpriseUpdate = {
  channel?: string
  pinnedVersion?: string
  autoUpdate?: boolean
  allowDowngrade?: boolean
  minimumVersion?: string
}

export type EnterpriseDeployment = {
  platforms?: string[]
  mode?: string
  offlineBundle?: boolean
  installerBaseUrl?: string
  proxyUrl?: string
}

export type PermissionMode = "allow" | "ask" | "deny"

/** Tool-level rules resolved for this client. */
export type EnterprisePermissions = {
  read: PermissionMode
  edit: PermissionMode
  bash: PermissionMode
  task: PermissionMode
  network: PermissionMode
  externalDirectory: PermissionMode
  skill: PermissionMode
  computer: PermissionMode
}

/**
 * The tenant profile baked into an enterprise installer. It mirrors the manifest
 * schema field for field, plus the build identity the installer itself needs.
 */
export type EnterpriseProfile = {
  kind: "omnia-enterprise-client"
  schema: 1
  distribution: string
  version: string
  publishedAt?: number
  name: string
  appId: string
  server: string
  manifestUrl: string
  loginUrl: string
  org: EnterpriseOrg
  branding: EnterpriseBranding
  auth: EnterpriseAuthPolicy
  features: Record<string, boolean>
  permissions?: Partial<EnterprisePermissions>
  experience: EnterpriseExperience
  limits: Record<string, number>
  models: {
    defaultModel?: string
    allowed?: string[]
    blocked?: string[]
    allowCustomProviders?: boolean
    allowByok?: boolean
  }
  telemetry: {
    enabled?: boolean
    includePrompts?: boolean
    includeFilePaths?: boolean
    retentionDays?: number
  }
  update: EnterpriseUpdate
  deployment: EnterpriseDeployment
}

/** The live rules the tenant server publishes for this build. */
export type EnterpriseManifest = {
  schema?: 1
  distribution?: string
  name?: string
  version?: string
  publishedAt?: number
  org?: EnterpriseOrg
  branding?: EnterpriseBranding
  auth?: EnterpriseAuthPolicy
  features?: Record<string, boolean>
  permissions?: Partial<EnterprisePermissions>
  experience?: EnterpriseExperience
  limits?: Record<string, number>
  models?: EnterpriseProfile["models"]
  telemetry?: EnterpriseProfile["telemetry"]
  update?: EnterpriseUpdate
  deployment?: EnterpriseDeployment
}

/**
 * Everything the admin configured, resolved for the client: the baked profile
 * underneath, the live manifest over it. The main process builds this so the
 * renderer has one read for branding, sign-in policy, feature switches,
 * experience defaults, limits, model access, telemetry and update policy.
 */
export type EnterprisePolicy = {
  /** Organization name and client name, for footers and titles. */
  org: string
  name: string
  branding: {
    productName: string
    shortName: string
    tagline: string
    primaryColor: string
    accentColor: string
    signInHeadline: string
    signInSubheadline: string
    logoUrl?: string
    iconUrl?: string
    supportUrl?: string
    docsUrl?: string
    footerText?: string
    showOmniaBranding: boolean
  }
  auth: {
    mode: string
    methods: string[]
    sessionHours: number
    requireMfa: boolean
    allowedEmailDomains: string[]
    allowSocialLogin: boolean
  }
  features: Record<string, boolean>
  permissions: EnterprisePermissions
  experience: {
    theme: string
    density: string
    locale: string
    homeSurface: string
    defaultMode: string
    instructions: string
    showTips: boolean
    showUsageMeter: boolean
  }
  limits: {
    monthlyTokensPerUser: number
    monthlySpendPerUserUsd: number
    maxComputersPerUser: number
    maxConcurrentSessions: number
    contextWindowTokens: number
    dailyScheduledRuns: number
    storageGb: number
    maxFileUploadMb: number
  }
  models: {
    defaultModel: string
    allowed: string[]
    blocked: string[]
    allowCustomProviders: boolean
    allowByok: boolean
  }
  telemetry: {
    enabled: boolean
    includePrompts: boolean
    includeFilePaths: boolean
    retentionDays: number
  }
  update: {
    channel: string
    pinnedVersion?: string
    autoUpdate: boolean
    allowDowngrade: boolean
    minimumVersion?: string
  }
}

/** Work-account sign-in and policy reads for a managed build (desktop only). */
export type EnterpriseClientPlatform = {
  /**
   * True when this installer was produced for an organization. Known before any
   * round trip, so a managed client can never fall back to the public
   * GitHub/Google sign-in while its profile is still loading or unavailable.
   */
  managed: boolean
  profile(): Promise<EnterpriseProfile | undefined>
  manifest(): Promise<EnterpriseManifest | undefined>
  /** The merged admin policy. Undefined outside a managed build. */
  policy(): Promise<EnterprisePolicy | undefined>
  signIn(identifier: string, password: string): Promise<GitHubAuthStatus>
  /**
   * Queues one finished turn for the organization's usage report.
   *
   * The main process owns the outbox, the dedupe by message id and the retry,
   * so a call is safe to repeat: it is the cheapest way to make reporting
   * survive a replayed event or a reload.
   */
  reportUsage(event: EnterpriseUsageEvent): Promise<unknown>
}

/** The numbers one assistant turn contributes to the organization's usage. */
export type EnterpriseUsageEvent = {
  /** Stable per-turn key, normally the assistant message id. */
  key: string
  model: string
  provider?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  durationMs?: number
  sessionId?: string
  tool?: string
}

/** OAuth sign-in through the hosted control plane (desktop only) */
export type GitHubAuthPlatform = {
  status(): Promise<GitHubAuthStatus>
  /** Omitted provider keeps the historical GitHub flow. */
  signIn(provider?: AuthProvider): Promise<GitHubAuthStatus>
  signOut(): Promise<GitHubAuthStatus>
  /** Present only when the installed build carries an organization profile. */
  enterprise?: EnterpriseClientPlatform
}

export type BrowserPanelTab = {
  readonly id: number
  readonly url: string
  readonly title?: string
  readonly active?: boolean
  readonly loading?: boolean
}

export type BrowserPanelCommand =
  | { readonly kind: "open"; readonly requestId: string; readonly url: string }
  | { readonly kind: "activate"; readonly tabId: number }
  | { readonly kind: "close"; readonly tabId: number }
  | {
      readonly kind: "dialog"
      readonly tabId: number
      readonly type: string
      readonly message: string
      readonly defaultPrompt?: string
      readonly frameUrl?: string
    }

export type BrowserPanelPlatform = {
  register(input: { webContentsId: number; requestId?: string; url?: string }): Promise<BrowserPanelTab | null>
  unregister(webContentsId: number): Promise<void>
  activate(webContentsId: number): Promise<void>
  list(): Promise<readonly BrowserPanelTab[]>
  answerDialog(input: {
    webContentsId: number
    accept: boolean
    promptText?: string
  }): Promise<{ handled: boolean } | undefined>
  onCommand(callback: (command: BrowserPanelCommand) => void): () => void
}

/** Structural copy of packages/omnia/src/specialists/types.ts; the app cannot import Omnia runtime code */
export type Specialist = {
  readonly role: string
  readonly name: string
  readonly focus: string
}

export type SpecialistRoster = {
  readonly entitled: boolean
  readonly custom: boolean
  readonly specialists: readonly Specialist[]
  readonly defaults: readonly Specialist[]
  readonly limits: {
    readonly minCount: number
    readonly maxCount: number
    readonly maxNameLength: number
    readonly maxFocusLength: number
  }
}

/** Discussion-room specialist roster; save and reset reject with the server's message when refused (desktop only) */
export type SpecialistsPlatform = {
  get(): Promise<SpecialistRoster>
  save(specialists: readonly Specialist[]): Promise<SpecialistRoster>
  reset(): Promise<SpecialistRoster>
}

/** Headless AI-employee runs and recurring schedules (desktop only). */
export type ScheduledRun = {
  readonly id: string
  readonly name: string
  readonly prompt: string
  readonly intervalMinutes: number
  readonly enabled: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastFiredAt?: number
  readonly lastResult?: {
    readonly ok: boolean
    readonly sessionId?: string
    readonly error?: string
    readonly at: number
  }
}

export type RunsPlatform = {
  list(): Promise<readonly ScheduledRun[]>
  create(input: { name: string; prompt: string; intervalMinutes: number }): Promise<ScheduledRun>
  update(id: string, patch: Partial<Pick<ScheduledRun, "name" | "prompt" | "intervalMinutes" | "enabled">>): Promise<ScheduledRun>
  remove(id: string): Promise<boolean>
  once(input: { prompt: string; title?: string; timeoutMs?: number }): Promise<{ ok: boolean; sessionId?: string; text?: string; error?: string; timedOut?: boolean }>
}

type PickerPaths = string | string[] | null
type OpenDirectoryPickerOptions = { title?: string; multiple?: boolean }
type OpenAttachmentPickerOptions = {
  title?: string
  multiple?: boolean
  accept?: string[]
  extensions?: string[]
  defaultPath?: string
}
type SaveFilePickerOptions = { title?: string; defaultPath?: string }
type PlatformName = "web" | "desktop"
type DesktopOS = "macos" | "windows" | "linux"

export type FatalRendererErrorLog = {
  error: string
  url: string
  version?: string
  platform: PlatformName
  os?: DesktopOS
}

export type LegalStatus = {
  readonly termsVersion: string
  readonly acceptedVersion: string | null
  readonly acceptedAt: number | null
  readonly accepted: boolean
  readonly banned: boolean
  readonly reason: string | null
  readonly bannedAt: number | null
  readonly fingerprint: string
  readonly sealed: boolean
  readonly source: "local" | "remote" | null
}

/** Terms acceptance and ban enforcement (desktop only). */
export type LegalPlatform = {
  status(): Promise<LegalStatus>
  accept(version: string): Promise<LegalStatus>
  /** Re-check the operator; restores a sealed database and relaunches when unbanned. */
  refresh(): Promise<LegalStatus>
  decline(): Promise<void>
}

type PlatformBase = {
  /** App version */
  version?: string

  /** Terms of Service acceptance and ban enforcement (desktop only) */
  legal?: LegalPlatform

  /** Open a web or mail URL in the default system application */
  openExternal(url: string): void

  /** Open a local path in a local app (desktop only) */
  openPath?(path: string, app?: string): Promise<void>

  /** Open a local file URL in its default app (desktop only) */
  openLocalFile?(url: string): void

  /** Reveal a local path in the system file manager; false when the path does not exist (desktop only) */
  revealPath?(path: string): Promise<boolean>

  /** Restart the app  */
  restart(): Promise<void>

  /** Send a system notification */
  notify(title: string, description?: string, onClick?: () => void): Promise<void>

  /** User-defined superskills: modular UI knowledge plus JSON-RPC bridges (desktop only) */
  superskills?: SuperskillPlatform

  /** Long-term memory: knowledge the agent keeps across sessions (desktop only) */
  memory?: MemoryPlatform

  /** Discussion-room specialists: custom rosters on Pro and above (desktop only) */
  specialists?: SpecialistsPlatform

  /** Headless AI-employee runs and recurring schedules (desktop only) */
  runs?: RunsPlatform

  /** GitHub sign-in through the hosted control plane (desktop only) */
  auth?: GitHubAuthPlatform

  /** Connected computers and their stored credentials (desktop only) */
  computers?: ComputerPlatform

  /** Messaging platforms Omnia answers on, on Pro and above (desktop only) */
  chat?: ChatPlatform

  /** Local computer-use models: download, load, and remove them on demand (desktop only) */
  computerUse?: ComputerUsePlatform

  /** Embedded browser panel backed by Electron <webview> pages (desktop only) */
  browserPanel?: BrowserPanelPlatform

  /** Open a native attachment picker and read selected files sequentially (desktop only) */
  openAttachmentPickerDialog?(
    opts: OpenAttachmentPickerOptions,
    onFile: (file: File) => Promise<unknown>,
  ): Promise<void>

  /** Resolve the native source path for a desktop File. */
  getPathForFile?(file: File): string

  /** Open a native save file picker dialog (desktop only) */
  saveFilePickerDialog?(opts?: SaveFilePickerOptions): Promise<string | null>

  /** Storage mechanism, defaults to localStorage */
  storage?: (name?: string) => SyncStorage | AsyncStorage

  /** Prompt drafts, history, and their blobs. */
  draftStore?: DraftStore

  /** Stable platform window identity for window-scoped persistence */
  windowID?: string

  /** Application-global desktop updater */
  updater?: UpdaterPlatform

  /** Fetch override */
  fetch?: typeof fetch

  /** Get the configured default server URL (platform-specific) */
  getDefaultServer?(): Promise<ServerConnection.Key | null>

  /** Set the default server URL to use on app startup (platform-specific) */
  setDefaultServer?(url: ServerConnection.Key | null): Promise<void> | void

  /** Manage WSL sidecar servers (Electron on Windows only) */
  wslServers?: WslServersPlatform

  /** Get the preferred display backend (desktop only) */
  getDisplayBackend?(): Promise<DisplayBackend | null> | DisplayBackend | null

  /** Set the preferred display backend (desktop only) */
  setDisplayBackend?(backend: DisplayBackend): Promise<void>

  /** Webview zoom level (desktop only) */
  webviewZoom?: Accessor<number>

  /** Whether the native desktop window is fullscreen */
  windowFullscreen?: Accessor<boolean>

  /** Get whether native pinch/Ctrl-scroll zoom gestures are enabled (desktop only) */
  getPinchZoomEnabled?(): Promise<boolean> | boolean

  /** Allow native pinch/Ctrl-scroll zoom gestures (desktop only) */
  setPinchZoomEnabled?(enabled: boolean): Promise<void> | void

  /** Run a desktop-only menu action from the app chrome */
  runDesktopMenuAction?(action: DesktopMenuAction): Promise<void> | void

  /** Check if an editor app exists (desktop only) */
  checkAppExists?(appName: string): Promise<boolean>

  /** Read image from clipboard (desktop only) */
  readClipboardImage?(): Promise<File | null>

  /** Export collected diagnostic logs (desktop only) */
  exportDebugLogs?(): Promise<string>

  /** Force focus styles on interactive elements through desktop devtools (desktop only) */
  setForceFocus?(enabled: boolean): Promise<void>

  /** Report whether the active agent session is working so the desktop can show its working indicator (desktop only) */
  setAgentWorking?(working: boolean): Promise<void> | void

  /** Record a fatal renderer error in platform logs (desktop only) */
  recordFatalRendererError?(error: FatalRendererErrorLog): Promise<void>
}

export type Platform = PlatformBase &
  (
    | { platform: "web"; os?: never }
    | {
        platform: "desktop"
        os?: DesktopOS
        openDirectoryPickerDialog(opts?: OpenDirectoryPickerOptions): Promise<PickerPaths>
      }
  )

export type DisplayBackend = "auto" | "wayland"

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
