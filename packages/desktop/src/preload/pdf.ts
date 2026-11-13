import { contextBridge, ipcRenderer } from "electron"
import {
  isPdfReaderDocument,
  PDF_READER_LOAD_CHANNEL,
  PDF_READER_SAVE_CHANNEL,
  type PdfReaderBridge,
  type PdfReaderSaveInput,
} from "../shared/pdf-reader"

// The browser guest preload is attached to every controlled tab, but only the
// reader document gets the bridge. Main validates the sender again, so a page
// that copies the reader's path on another origin reaches no IPC handler.
if (isPdfReaderDocument(location.href)) {
  const bridge: PdfReaderBridge = {
    load: (url) => ipcRenderer.invoke(PDF_READER_LOAD_CHANNEL, url),
    save: (input: PdfReaderSaveInput) => ipcRenderer.invoke(PDF_READER_SAVE_CHANNEL, input),
  }
  contextBridge.exposeInMainWorld("pdfReader", bridge)
}
