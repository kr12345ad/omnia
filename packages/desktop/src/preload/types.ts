import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import type { BrowserPanelPlatform, GitHubAuthPlatform, SpecialistsPlatform, RunsPlatform } from "@opencode-ai/app/context/platform"
import type { ComputerPlatform } from "@opencode-ai/app/computers"
import type { ChatPlatform } from "@opencode-ai/app/chat"
import type { ComputerUsePlatform } from "@opencode-ai/app/computer-use"
import type { WslServersPlatform } from "@opencode-ai/app/wsl/types"
import type { UpdaterState } from "@opencode-ai/app/updater"
import type { DesktopNativeBundle } from "@opencode-ai/app/i18n/desktop-native"
import type { OmniaAPI } from "../main/omnia/types"

export type SuperskillSummary = {
  id: string
  name: string
  description: string
  enabled: boolean
  version?: string
  author?: string
  bridgeType: "stdio" | "http"
  methods: string[]
}

export type SuperskillMethod = {
  name: string
  description: string
  parameters?: Record<string, unknown>
  scopes?: string[]
}

export type Superskill = {
  id: string
  name: string
  description: string
  instructions: string
  enabled: boolean
  version?: string
  author?: string
  scopes?: string[]
  bridge: { type: "stdio" | "http"; command?: string; url?: string; env?: Record<string, string>; timeoutMs?: number }
  methods: SuperskillMethod[]
}

export type SuperskillPlatform = {
  list(): Promise<SuperskillSummary[]>
  get(id: string): Promise<Superskill>
  save(skill: Superskill): Promise<Superskill>
  remove(id: string): Promise<boolean>
  call(id: string, method: string, params: unknown): Promise<unknown>
}

export type MemoryScope = "session" | "task" | "workspace" | "user" | "skill" | "application"

export type MemoryRecord = {
  id: string
  scope: MemoryScope
  text: string
  key?: string
  tags?: string[]
  application?: string
  sessionId?: string
  workspace?: string
  source: "agent" | "system" | "user"
  confidence: number
  sensitivity: "public" | "internal" | "private"
  createdAt: number
  updatedAt: number
  expiresAt?: number
}

export type MemoryPlatform = {
  list(input?: { query?: string; scope?: string; application?: string; limit?: number }): Promise<MemoryRecord[]>
  remove(id: string): Promise<boolean>
  forget(input: { query?: string; key?: string; scope?: string; application?: string }): Promise<number>
  stats(): Promise<Record<string, number>>
}

export type {
  OmniaAction,
  OmniaAPI,
  OmniaBlockedReason,
  OmniaCapabilities,
  OmniaEvent,
  OmniaExecuteRequest,
  OmniaFailure,
  OmniaExecution,
  OmniaFindRequest,
  OmniaFindResult,
  OmniaObservation,
  OmniaResult,
  OmniaSubscribeResult,
  OmniaTargetReference,
  OmniaUnavailableReason,
} from "../main/omnia/types"
export type {
  WslDistroProbe,
  WslInstalledDistro,
  WslJob,
  WslOnlineDistro,
  WslOpencodeCheck,
  WslRuntimeCheck,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
} from "@opencode-ai/app/wsl/types"

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type WslServersAPI = WslServersPlatform
export type UpdaterAPI = {
  subscribe: (cb: (state: UpdaterState) => void) => Promise<() => void>
  check: () => Promise<UpdaterState>
  install: () => Promise<void>
}

export type LinuxDisplayBackend = "wayland" | "auto"
export type TitlebarTheme = {
  mode: "light" | "dark"
  scheme?: "system" | "light" | "dark"
}
export type FatalRendererError = {
  error: string
  url: string
  version?: string
  platform: string
  os?: string
}

export type ElectronAPI = {
  /** Plan, allowance and per-capability decisions. Absent meant the renderer
   *  could never learn its entitlements, so the paywall rendered nothing. */
  billing: {
    entitlement: () => Promise<unknown>
    check: (capability: string) => Promise<unknown>
    checkout: (plan: string) => Promise<unknown>
    portal: () => Promise<unknown>
  }
  omnia: OmniaAPI
  superskills: SuperskillPlatform
  memory: MemoryPlatform
  specialists: SpecialistsPlatform
  runs: RunsPlatform
  auth: GitHubAuthPlatform
  computers: ComputerPlatform
  chat: ChatPlatform
  computerUse: ComputerUsePlatform
  browserPanel: BrowserPanelPlatform
  killSidecar: () => Promise<void>
  installCli: () => Promise<string>
  awaitInitialization: () => Promise<ServerReadyData>
  wslServers: WslServersAPI
  updater: UpdaterAPI
  consumeInitialDeepLinks: () => Promise<string[]>
  getDefaultServerUrl: () => Promise<string | null>
  setDefaultServerUrl: (url: string | null) => Promise<void>
  isFirstLaunchOnboardingPending: () => Promise<boolean>
  finishFirstLaunchOnboarding: (createDefaultProject: boolean) => Promise<string | null>
  importSourcesDetect: () => Promise<
    {
      kind: "opencode" | "codex"
      path: string
      bytes: number
      sessions: number
      messages: number
      oldest: number | null
      newest: number | null
    }[]
  >
  importSessionsRun: (input: { kind: "opencode" | "codex"; path: string }) => Promise<{
    source: string
    kind: "opencode" | "codex"
    importedSessions: number
    importedMessages: number
    importedParts: number
    skippedSessions: number
    errors: string[]
  }>
  isOldLayoutEligible: () => Promise<boolean>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  checkAppExists: (appName: string) => Promise<boolean>
  resolveAppPath: (appName: string) => Promise<string | null>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>
  draftGet: (key: string) => Promise<string | null>
  draftSet: (key: string, value: string) => Promise<void>
  draftDelete: (key: string) => Promise<void>
  draftBlobPut: (data: ArrayBuffer) => Promise<string>
  draftBlobGet: (id: string) => Promise<ArrayBuffer | null>

  getWindowID: () => Promise<string>
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    extensions?: string[]
  }) => Promise<{ token: string; files: { path: string; name: string; size: number }[] } | null>
  readPickedFile: (token: string, path: string) => Promise<ArrayBuffer>
  releasePickedFiles: (token: string) => Promise<void>
  getPathForFile: (file: File) => string
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  openExternal: (url: string) => void
  openLocalFile: (url: string) => void
  openPath: (path: string, app?: string) => Promise<void>
  revealPath: (path: string) => Promise<boolean>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  getWindowFocused: () => Promise<boolean>
  getWindowFullscreen: () => Promise<boolean>
  onWindowFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  getPinchZoomEnabled: () => Promise<boolean>
  setPinchZoomEnabled: (enabled: boolean) => Promise<void>
  onPinchZoomEnabledChanged: (cb: (enabled: boolean) => void) => () => void
  onZoomFactorChanged: (cb: (factor: number) => void) => () => void
  setTitlebar: (theme: TitlebarTheme) => Promise<void>
  runDesktopMenuAction: (action: DesktopMenuAction) => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>
  setAgentWorking: (working: boolean) => void
  exportDebugLogs: () => Promise<string>
  setForceFocus: (enabled: boolean) => Promise<void>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void>
  setNativeTranslations: (bundle: DesktopNativeBundle) => Promise<void>
}
