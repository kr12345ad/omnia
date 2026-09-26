import type { LocatorReference } from "./locator"

export type BrowserId = string
export type BrowserContextId = string
export type TabId = string
export type PageId = string
export type FrameId = string
export type DocumentId = string
export type DownloadId = string

export type PageLifecycle = "unloaded" | "loading" | "dom-content-loaded" | "interactive" | "complete" | "crashed"

export type NavigationPhase = "idle" | "pending" | "committed" | "failed"

export type NavigationKind =
  | "address-bar"
  | "back"
  | "forward"
  | "form"
  | "link"
  | "redirect"
  | "reload"
  | "script"
  | "other"

export interface NavigationError {
  readonly message: string
  readonly code?: string
}

export interface NavigationState {
  readonly phase: NavigationPhase
  readonly kind: NavigationKind
  readonly url: string
  readonly fromUrl?: string
  readonly targetUrl?: string
  readonly startedAt?: string
  readonly error?: NavigationError
  readonly canGoBack: boolean
  readonly canGoForward: boolean
}

export interface Viewport {
  readonly width: number
  readonly height: number
  readonly deviceScaleFactor?: number
  readonly scrollX?: number
  readonly scrollY?: number
}

export interface BrowserFrame {
  readonly id: FrameId
  readonly parentId?: FrameId
  readonly url?: string
  readonly name?: string
}

export interface PageModel {
  readonly id: PageId
  readonly tabId: TabId
  readonly documentId: DocumentId
  readonly url: string
  readonly title: string
  readonly lifecycle: PageLifecycle
  readonly navigation: NavigationState
  readonly frames: readonly BrowserFrame[]
  readonly viewport?: Viewport
}

export interface BrowserTab {
  readonly id: TabId
  readonly contextId: BrowserContextId
  readonly page: PageModel
  readonly active: boolean
  readonly openerTabId?: TabId
  readonly audible?: boolean
}

export interface BrowserDriverCapabilities {
  readonly tabs: boolean
  readonly navigation: boolean
  readonly domSnapshots: boolean
  readonly accessibilitySnapshots: boolean
  readonly downloads: boolean
  readonly uploads: boolean
  readonly screenshots: boolean
}

export interface OpenTabInput {
  readonly url?: string
  readonly active?: boolean
  readonly openerTabId?: TabId
}

export interface OperationOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export interface NavigationOptions extends OperationOptions {
  readonly waitUntil?: "dom-content-loaded" | "interactive" | "complete" | "network-idle"
}

export interface PageCaptureOptions extends OperationOptions {
  readonly includeDom?: boolean
  readonly includeAccessibility?: boolean
}

export type DownloadState = "pending" | "in-progress" | "completed" | "failed" | "canceled"

export type DownloadDestination =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "opaque"; readonly value: string }

export interface DownloadArtifact {
  readonly id: DownloadId
  readonly pageId?: PageId
  readonly url: string
  readonly suggestedFilename: string
  readonly mimeType?: string
  readonly byteLength?: number
  readonly state: DownloadState
  readonly failure?: string
  readonly destination?: DownloadDestination
}

export interface DownloadRequest extends OperationOptions {
  readonly locator?: LocatorReference
}

export type UploadSource =
  | { readonly kind: "bytes"; readonly data: Uint8Array }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "url"; readonly url: string }

export interface UploadFile {
  readonly name: string
  readonly mimeType?: string
  readonly byteLength?: number
  readonly source: UploadSource
}
