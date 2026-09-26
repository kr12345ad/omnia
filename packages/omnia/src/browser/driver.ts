import type { DriverLocator, LocatorReference } from "./locator"
import type {
  BrowserDriverCapabilities,
  BrowserId,
  BrowserTab,
  DownloadArtifact,
  DownloadRequest,
  NavigationOptions,
  OpenTabInput,
  OperationOptions,
  PageCaptureOptions,
  PageId,
  PageLifecycle,
  PageModel,
  TabId,
  UploadFile,
} from "./model"
import type { PageSnapshot } from "./snapshot"

export interface DriverPage {
  getModel(options?: OperationOptions): Promise<PageModel>
  capture(options?: PageCaptureOptions): Promise<PageSnapshot>
  navigate(url: string, options?: NavigationOptions): Promise<PageModel>
  reload(options?: NavigationOptions): Promise<PageModel>
  goBack(options?: NavigationOptions): Promise<PageModel>
  goForward(options?: NavigationOptions): Promise<PageModel>
  waitForLoadState(state: PageLifecycle, options?: NavigationOptions): Promise<PageModel>
  locator(reference: LocatorReference): DriverLocatorHandle
  waitForDownload(options?: DownloadRequest): Promise<DownloadArtifact>
}

export type DriverLocatorHandle = DriverLocator

export interface BrowserDriver {
  readonly id: BrowserId
  readonly capabilities: BrowserDriverCapabilities
  listTabs(options?: OperationOptions): Promise<readonly BrowserTab[]>
  openTab(input?: OpenTabInput, options?: OperationOptions): Promise<BrowserTab>
  activateTab(tabId: TabId, options?: OperationOptions): Promise<void>
  closeTab(tabId: TabId, options?: OperationOptions): Promise<void>
  page(pageId: PageId): DriverPage
  listDownloads(pageId?: PageId, options?: OperationOptions): Promise<readonly DownloadArtifact[]>
  close(options?: OperationOptions): Promise<void>
}
