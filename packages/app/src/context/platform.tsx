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
  controlPlaneUrl?: string
}

/** OAuth sign-in through the hosted control plane (desktop only) */
export type GitHubAuthPlatform = {
  status(): Promise<GitHubAuthStatus>
  /** Omitted provider keeps the historical GitHub flow. */
  signIn(provider?: AuthProvider): Promise<GitHubAuthStatus>
  signOut(): Promise<GitHubAuthStatus>
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

type PlatformBase = {
  /** App version */
  version?: string

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
