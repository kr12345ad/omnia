import { compactPage } from "./compact"
import type { CompactPageOptions, CompactPageRetrieval } from "./compact"
import type { BrowserDriver, DriverLocatorHandle } from "./driver"
import type { ElementLocator, LocatorReference, UploadOptions } from "./locator"
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
import { toObservation } from "./protocol"
import type { BrowserObservation, ProtocolObservationOptions } from "./protocol"
import { deriveSemanticPageState } from "./snapshot"
import type { SemanticPageOptions, SemanticPageState } from "./snapshot"

export interface BrowserTabSurface {
  list(options?: OperationOptions): Promise<readonly BrowserTab[]>
  open(input?: OpenTabInput, options?: OperationOptions): Promise<BrowserTab>
  activate(tabId: TabId, options?: OperationOptions): Promise<void>
  close(tabId: TabId, options?: OperationOptions): Promise<void>
}

export interface BrowserPageSurface {
  get(pageId: PageId, options?: OperationOptions): Promise<PageModel>
  observe(
    pageId: PageId,
    options?: SemanticPageOptions & PageCaptureOptions & ProtocolObservationOptions,
  ): Promise<BrowserObservation>
  inspect(pageId: PageId, options?: SemanticPageOptions & PageCaptureOptions): Promise<SemanticPageState>
  retrieve(
    pageId: PageId,
    options?: SemanticPageOptions & PageCaptureOptions & CompactPageOptions,
  ): Promise<CompactPageRetrieval>
  navigate(pageId: PageId, url: string, options?: NavigationOptions): Promise<PageModel>
  reload(pageId: PageId, options?: NavigationOptions): Promise<PageModel>
  back(pageId: PageId, options?: NavigationOptions): Promise<PageModel>
  forward(pageId: PageId, options?: NavigationOptions): Promise<PageModel>
  waitForLoadState(pageId: PageId, state: PageLifecycle, options?: NavigationOptions): Promise<PageModel>
}

export interface BrowserTransferSurface {
  listDownloads(pageId?: PageId, options?: OperationOptions): Promise<readonly DownloadArtifact[]>
  waitForDownload(pageId: PageId, options?: DownloadRequest): Promise<DownloadArtifact>
  upload(reference: LocatorReference, files: readonly UploadFile[], options?: UploadOptions): Promise<void>
}

export interface BrowserSurface {
  readonly id: BrowserId
  readonly capabilities: BrowserDriverCapabilities
  readonly tabs: BrowserTabSurface
  readonly pages: BrowserPageSurface
  readonly transfers: BrowserTransferSurface
  locator(reference: LocatorReference): ElementLocator
  close(options?: OperationOptions): Promise<void>
}

export function createBrowserSurface(driver: BrowserDriver): BrowserSurface {
  return {
    id: driver.id,
    capabilities: driver.capabilities,
    tabs: {
      list: (options) => driver.listTabs(options),
      open: (input, options) => driver.openTab(input, options),
      activate: (tabId, options) => driver.activateTab(tabId, options),
      close: (tabId, options) => driver.closeTab(tabId, options),
    },
    pages: {
      get: (pageId, options) => driver.page(pageId).getModel(options),
      observe: async (pageId, options = {}) =>
        toObservation(deriveSemanticPageState(await driver.page(pageId).capture(options), options), options),
      inspect: async (pageId, options = {}) =>
        deriveSemanticPageState(await driver.page(pageId).capture(options), options),
      retrieve: async (pageId, options = {}) =>
        compactPage(deriveSemanticPageState(await driver.page(pageId).capture(options), options), options),
      navigate: (pageId, url, options) => driver.page(pageId).navigate(url, options),
      reload: (pageId, options) => driver.page(pageId).reload(options),
      back: (pageId, options) => driver.page(pageId).goBack(options),
      forward: (pageId, options) => driver.page(pageId).goForward(options),
      waitForLoadState: (pageId, state, options) => driver.page(pageId).waitForLoadState(state, options),
    },
    transfers: {
      listDownloads: (pageId, options) => driver.listDownloads(pageId, options),
      waitForDownload: (pageId, options) => driver.page(pageId).waitForDownload(options),
      upload: (reference, files, options) => driver.page(reference.pageId).locator(reference).upload(files, options),
    },
    locator: (reference) => wrapLocator(driver.page(reference.pageId).locator(reference), reference),
    close: (options) => driver.close(options),
  }
}

function wrapLocator(locator: DriverLocatorHandle, reference: LocatorReference): ElementLocator {
  return {
    reference,
    click: (options) => locator.click(options),
    fill: (value, options) => locator.fill(value, options),
    select: (values, options) => locator.select(values, options),
    check: (options) => locator.check(options),
    press: (key, options) => locator.press(key, options),
    focus: (options) => locator.focus(options),
    waitFor: (options) => locator.waitFor(options),
    textContent: (options) => locator.textContent(options),
    inputValue: (options) => locator.inputValue(options),
    upload: (files, options) => locator.upload(files, options),
  }
}
