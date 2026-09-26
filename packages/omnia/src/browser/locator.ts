import type { OperationOptions, PageId, FrameId, DocumentId, UploadFile } from "./model"

export type Selector =
  | { readonly kind: "css"; readonly value: string }
  | { readonly kind: "xpath"; readonly value: string }
  | { readonly kind: "text"; readonly value: string; readonly exact?: boolean }
  | { readonly kind: "role"; readonly role: string; readonly name?: string; readonly exact?: boolean }
  | { readonly kind: "label"; readonly value: string; readonly exact?: boolean }
  | { readonly kind: "test-id"; readonly value: string }
  | { readonly kind: "dom-node"; readonly value: string }
  | { readonly kind: "opaque"; readonly value: string }

export interface LocatorReference {
  readonly pageId: PageId
  readonly frameId: FrameId
  readonly documentId: DocumentId
  readonly selector: Selector
  readonly match: "first" | "strict"
  readonly ordinal?: number
}

export interface ClickOptions extends OperationOptions {
  readonly button?: "left" | "middle" | "right"
  readonly clickCount?: number
  readonly modifiers?: readonly ("Alt" | "Control" | "Meta" | "Shift")[]
  readonly force?: boolean
}

export type FillOptions = OperationOptions

export type SelectOptions = OperationOptions

export interface CheckOptions extends OperationOptions {
  readonly checked?: boolean
}

export type PressOptions = OperationOptions

export interface WaitForLocatorOptions extends OperationOptions {
  readonly state?: "attached" | "detached" | "visible" | "hidden"
}

export type UploadOptions = OperationOptions

export interface DriverLocator {
  click(options?: ClickOptions): Promise<void>
  fill(value: string, options?: FillOptions): Promise<void>
  select(values: readonly string[], options?: SelectOptions): Promise<void>
  check(options?: CheckOptions): Promise<void>
  press(key: string, options?: PressOptions): Promise<void>
  focus(options?: OperationOptions): Promise<void>
  waitFor(options?: WaitForLocatorOptions): Promise<void>
  textContent(options?: OperationOptions): Promise<string | null>
  inputValue(options?: OperationOptions): Promise<string>
  upload(files: readonly UploadFile[], options?: UploadOptions): Promise<void>
}

export interface ElementLocator extends DriverLocator {
  readonly reference: LocatorReference
}
