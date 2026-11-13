import { afterEach, describe, expect, test } from "bun:test"
import {
  PDF_READER_MAX_SAVE_BYTES,
  isPdfReaderResourceUrl,
  isPdfReaderUrl,
  pdfFileName,
  pdfReaderSource,
  pdfReaderUrl,
} from "./pdf-reader"

const previousRendererUrl = process.env.ELECTRON_RENDERER_URL

afterEach(() => {
  if (previousRendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
  else process.env.ELECTRON_RENDERER_URL = previousRendererUrl
})

describe("pdf reader urls", () => {
  test("uses the oc protocol in a packaged renderer", () => {
    delete process.env.ELECTRON_RENDERER_URL
    const url = pdfReaderUrl("https://example.test/files/invoice.php?id=7")
    expect(url).toBe("oc://renderer/pdf.html?url=https%3A%2F%2Fexample.test%2Ffiles%2Finvoice.php%3Fid%3D7")
    expect(isPdfReaderUrl(url)).toBe(true)
    expect(pdfReaderSource(url)).toBe("https://example.test/files/invoice.php?id=7")
  })

  test("uses the dev server while developing", () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173"
    const url = pdfReaderUrl("https://example.test/a.pdf")
    expect(url).toBe("http://localhost:5173/pdf.html?url=https%3A%2F%2Fexample.test%2Fa.pdf")
    expect(isPdfReaderUrl(url)).toBe(true)
    expect(pdfReaderSource(url)).toBe("https://example.test/a.pdf")
  })

  test("does not treat another page or origin as the reader", () => {
    delete process.env.ELECTRON_RENDERER_URL
    expect(isPdfReaderUrl("oc://renderer/index.html?url=https%3A%2F%2Fexample.test%2Fa.pdf")).toBe(false)
    expect(isPdfReaderUrl("oc://other/pdf.html")).toBe(false)
    expect(pdfReaderSource("oc://renderer/pdf.html")).toBeUndefined()
    expect(pdfReaderSource("oc://renderer/pdf.html?url=not-a-url")).toBeUndefined()
  })

  test("allows the local renderer's worker and styles in development", () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173"
    expect(isPdfReaderResourceUrl("http://localhost:5173/assets/pdf.worker.min.mjs")).toBe(true)
    expect(isPdfReaderResourceUrl("https://example.test/assets/pdf.worker.min.mjs")).toBe(false)
    delete process.env.ELECTRON_RENDERER_URL
    expect(isPdfReaderResourceUrl("https://example.test/assets/pdf.worker.min.mjs")).toBe(false)
  })
})

describe("pdf file names", () => {
  test("uses a quoted or unquoted disposition filename", () => {
    expect(pdfFileName("https://example.test/download.php", 'attachment; filename="invoice 7.pdf"')).toBe("invoice 7.pdf")
    expect(pdfFileName("https://example.test/download.php", "attachment; filename=report.pdf")).toBe("report.pdf")
  })

  test("falls back to the URL path and adds the extension", () => {
    expect(pdfFileName("https://example.test/files/Statement.PDF")).toBe("Statement.PDF")
    expect(pdfFileName("https://example.test/files/download")).toBe("download.pdf")
    expect(pdfFileName("https://example.test/")).toBe("document.pdf")
  })

  test("removes path separators, control characters and a leading dot", () => {
    const traversal = pdfFileName("https://example.test/", 'attachment; filename="../../etc/passwd"')
    expect(traversal).not.toContain("/")
    expect(traversal.startsWith(".")).toBe(false)
    expect(traversal.endsWith(".pdf")).toBe(true)
    expect(pdfFileName("https://example.test/", 'attachment; filename="bad\u0000name.pdf"')).toBe("bad_name.pdf")
  })

  test("bounds long names", () => {
    const name = pdfFileName(`https://example.test/${"a".repeat(400)}.pdf`)
    expect(name.length).toBeLessThanOrEqual(120)
    expect(name.endsWith(".pdf")).toBe(true)
    expect(PDF_READER_MAX_SAVE_BYTES).toBeGreaterThan(0)
  })
})
