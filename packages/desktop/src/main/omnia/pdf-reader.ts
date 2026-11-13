// The pdf.js reader lives in a browser guest, but the document bytes are
// fetched here so the reader shares the browser partition's cookies and never
// depends on a cross-origin fetch from the reader page. This process also owns
// the only write path: a PDF can be saved into Downloads, never to a path the
// page chooses.

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { app, ipcMain, session } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import { isNavigableBrowserUrl } from "@opencode-ai/omnia/browser/url-policy"
import {
  PDF_READER_LOAD_CHANNEL,
  PDF_READER_MAX_LOAD_BYTES,
  PDF_READER_MAX_SAVE_BYTES,
  PDF_READER_SAVE_CHANNEL,
  isPdfReaderUrl,
  pdfFileName,
} from "../../shared/pdf-reader"
import type { PdfReaderLoadResult, PdfReaderSaveResult } from "../../shared/pdf-reader"
import { BROWSER_PARTITION } from "./browser-view"

let registered = false

export function registerPdfReaderIpc(): void {
  if (registered) return
  registered = true
  ipcMain.handle(PDF_READER_LOAD_CHANNEL, async (event, value: unknown) => {
    requireReaderSender(event)
    return load(value)
  })
  ipcMain.handle(PDF_READER_SAVE_CHANNEL, async (event, value: unknown) => {
    requireReaderSender(event)
    return save(value)
  })
}

function requireReaderSender(event: IpcMainInvokeEvent): void {
  if (event.senderFrame === null || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("The PDF reader request did not come from the top-level reader page.")
  }
  if (!isPdfReaderUrl(event.sender.getURL())) {
    throw new Error("The PDF reader request did not come from the built-in reader.")
  }
}

async function load(value: unknown): Promise<PdfReaderLoadResult> {
  if (typeof value !== "string" || !isNavigableBrowserUrl(value)) {
    throw new Error("The PDF address is not a public http(s) URL.")
  }
  const response = await session.fromPartition(BROWSER_PARTITION).fetch(value, {
    redirect: "follow",
    headers: { accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8" },
  })
  const finalUrl = response.url.length === 0 ? value : response.url
  if (!isNavigableBrowserUrl(finalUrl)) {
    throw new Error("The PDF request redirected to a private address, which is not allowed.")
  }
  if (!response.ok) {
    throw new Error(`The PDF request failed with HTTP ${response.status}.`)
  }
  const declared = response.headers.get("content-length")
  if (declared !== null && Number(declared) > PDF_READER_MAX_LOAD_BYTES) {
    throw new Error(`The PDF is larger than the ${Math.round(PDF_READER_MAX_LOAD_BYTES / (1024 * 1024))} MB reader limit.`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > PDF_READER_MAX_LOAD_BYTES) {
    throw new Error(`The PDF is larger than the ${Math.round(PDF_READER_MAX_LOAD_BYTES / (1024 * 1024))} MB reader limit.`)
  }
  if (!hasPdfHeader(bytes)) {
    throw new Error("The address did not return a PDF document.")
  }
  return {
    data: bytes,
    name: pdfFileName(finalUrl, response.headers.get("content-disposition") ?? undefined),
    url: finalUrl,
  }
}

async function save(value: unknown): Promise<PdfReaderSaveResult> {
  if (typeof value !== "object" || value === null) {
    throw new Error("The PDF save request is invalid.")
  }
  const record = value as Record<string, unknown>
  const data = bytesOf(record.data)
  if (data === undefined) {
    throw new Error("The PDF save request did not include document bytes.")
  }
  if (data.byteLength > PDF_READER_MAX_SAVE_BYTES) {
    throw new Error(`The PDF is larger than the ${Math.round(PDF_READER_MAX_SAVE_BYTES / (1024 * 1024))} MB save limit.`)
  }
  const name = pdfFileName(`https://local/${typeof record.name === "string" ? record.name : "document.pdf"}`)
  const directory = app.getPath("downloads")
  await mkdir(directory, { recursive: true })
  for (let index = 0; index < 1000; index += 1) {
    const path = join(directory, index === 0 ? name : numberedName(name, index))
    try {
      await writeFile(path, data, { flag: "wx" })
      return { path }
    } catch (error) {
      if (!isAlreadyPresent(error)) throw error
    }
  }
  throw new Error("Could not choose a free name for the filled PDF in Downloads.")
}

// pdf.js accepts a PDF whose header is not at byte zero, so the first 1024
// bytes are searched rather than requiring the file to start with %PDF-.
function hasPdfHeader(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024))
  return head.indexOf("%PDF-") >= 0
}

function bytesOf(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return undefined
}

function numberedName(name: string, index: number): string {
  return `${name.slice(0, -4)} (${index}).pdf`
}

function isAlreadyPresent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST"
}
