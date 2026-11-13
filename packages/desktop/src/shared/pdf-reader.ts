// The built-in pdf.js reader is an ordinary browser guest page, so the agent's
// existing page tools (read, find, type, click) work on its text layer and form
// controls without a parallel protocol. This module is the small shared surface
// between the main process, the guest preload, and the reader renderer.

export const PDF_READER_FILE = "pdf.html"
export const PDF_READER_ORIGIN = "oc://renderer"
export const PDF_READER_LOAD_CHANNEL = "pdf-reader-load"
export const PDF_READER_SAVE_CHANNEL = "pdf-reader-save"
// A PDF is held in memory on both sides of IPC, so the cap has to cover the
// largest document worth opening in the panel rather than the largest download.
export const PDF_READER_MAX_LOAD_BYTES = 64 * 1024 * 1024
export const PDF_READER_MAX_SAVE_BYTES = 128 * 1024 * 1024

export type PdfReaderLoadResult = {
  readonly data: Uint8Array
  readonly name: string
  readonly url: string
}

export type PdfReaderSaveInput = {
  readonly data: Uint8Array
  readonly name?: string
}

export type PdfReaderSaveResult = {
  readonly path: string
}

export type PdfReaderBridge = {
  load(url: string): Promise<PdfReaderLoadResult>
  save(input: PdfReaderSaveInput): Promise<PdfReaderSaveResult>
}

function devRendererBase(): string | undefined {
  const value = process.env.ELECTRON_RENDERER_URL
  if (value === undefined || !URL.canParse(value)) return undefined
  return value
}

// The reader is a renderer entry: electron-vite serves it from the dev server
// while developing and from the oc protocol in a packaged build.
export function pdfReaderUrl(source: string): string {
  const query = `url=${encodeURIComponent(source)}`
  const base = devRendererBase()
  if (base !== undefined) return new URL(`${PDF_READER_FILE}?${query}`, base).toString()
  return `${PDF_READER_ORIGIN}/${PDF_READER_FILE}?${query}`
}

export function isPdfReaderUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (url.pathname !== `/${PDF_READER_FILE}`) return false
  if (url.protocol === "oc:" && url.host === "renderer") return true
  const base = devRendererBase()
  return base !== undefined && url.origin === new URL(base).origin
}

// Only the exact reader document gets the preload bridge. Main still validates
// every IPC sender, so a same-path page on another origin cannot load a PDF.
export function isPdfReaderDocument(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.pathname === `/${PDF_READER_FILE}`
}

export function pdfReaderSource(value: string): string | undefined {
  if (!isPdfReaderUrl(value)) return undefined
  const source = new URL(value).searchParams.get("url")
  if (source === null || source.length === 0 || !URL.canParse(source)) return undefined
  return source
}

// The reader's worker and styles are local renderer assets on its own origin:
// the packaged oc://renderer document and, in development, the Vite server.
// Everything under those origins is app content, not web content.
export function isPdfReaderResourceUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (url.protocol === "oc:" && url.host === "renderer") return true
  const base = devRendererBase()
  return base !== undefined && url.origin === new URL(base).origin
}

const PDF_NAME_MAX_LENGTH = 120

// The download filename is attacker-controlled too, so it is reduced to a safe
// basename: no directories, no control characters, and always a .pdf suffix.
export function pdfFileName(source: string, disposition?: string): string {
  const fromDisposition = disposition === undefined ? undefined : dispositionFilename(disposition)
  const fromUrl = (() => {
    try {
      return decodeURIComponent(new URL(source).pathname.split("/").at(-1) ?? "")
    } catch {
      return ""
    }
  })()
  const candidate = (fromDisposition ?? fromUrl).trim()
  const base = candidate
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_")
    .replace(/\s+/gu, " ")
    .replace(/^\.+/u, "")
    .trim()
  const named = base.length === 0 ? "document.pdf" : base
  const withSuffix = named.toLowerCase().endsWith(".pdf") ? named : `${named}.pdf`
  return withSuffix.length <= PDF_NAME_MAX_LENGTH
    ? withSuffix
    : `${withSuffix.slice(0, PDF_NAME_MAX_LENGTH - 4)}.pdf`
}

function dispositionFilename(value: string): string | undefined {
  const match = /filename\*?=(?:UTF-8''|"?)([^";]+)/iu.exec(value)
  return match?.[1]?.trim()
}
