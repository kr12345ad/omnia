import type { ElectronAPI } from "../preload/types"

declare global {
  interface Window {
    api: ElectronAPI
    pdfReader?: import("../shared/pdf-reader").PdfReaderBridge
    __OPENCODE__?: {
      deepLinks?: string[]
    }
  }
}
