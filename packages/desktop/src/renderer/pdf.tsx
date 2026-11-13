import { AnnotationMode, GlobalWorkerOptions, getDocument } from "pdfjs-dist"
import { EventBus, PDFFindController, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs"
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import "pdfjs-dist/web/pdf_viewer.css"
import "./pdf.css"

GlobalWorkerOptions.workerSrc = workerSrc

type PdfReaderLoadResult = {
  readonly data: Uint8Array
  readonly name: string
  readonly url: string
}

type PdfReaderSaveInput = {
  readonly data: Uint8Array
  readonly name?: string
}

type PdfReaderBridge = {
  load(url: string): Promise<PdfReaderLoadResult>
  save(input: PdfReaderSaveInput): Promise<{ path: string }>
}

type StatusTone = "info" | "error" | "success"

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (element === null) throw new Error(`The PDF reader is missing ${selector}.`)
  return element
}

const bridge = (window as Window & { readonly pdfReader?: PdfReaderBridge }).pdfReader
const viewerContainer = requireElement<HTMLDivElement>("#viewerContainer")
const viewerElement = requireElement<HTMLDivElement>("#viewer")
const status = requireElement<HTMLDivElement>("#pdf-status")
const pageLabel = requireElement<HTMLSpanElement>("#pdf-page")
const zoomLabel = requireElement<HTMLSpanElement>("#pdf-zoom")
const fieldsLabel = requireElement<HTMLSpanElement>("#pdf-fields")
const fileLabel = requireElement<HTMLSpanElement>("#pdf-file")
const previousButton = requireElement<HTMLButtonElement>("#pdf-prev")
const nextButton = requireElement<HTMLButtonElement>("#pdf-next")
const zoomOutButton = requireElement<HTMLButtonElement>("#pdf-zoom-out")
const zoomInButton = requireElement<HTMLButtonElement>("#pdf-zoom-in")
const saveButton = requireElement<HTMLButtonElement>("#pdf-save")

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "PasswordException") {
      return "This PDF is password protected and cannot be opened in the reader yet."
    }
    if (error.name === "InvalidPDFException") return "This file is not a valid PDF."
    return error.message.length === 0 ? "The PDF could not be opened." : error.message
  }
  return "The PDF could not be opened."
}

function setStatus(message: string, tone: StatusTone = "info"): void {
  status.textContent = message
  status.dataset.tone = tone
}

function setControlsEnabled(enabled: boolean): void {
  zoomOutButton.disabled = !enabled
  zoomInButton.disabled = !enabled
  saveButton.disabled = !enabled
}

function updatePageControls(viewer: PDFViewer): void {
  const count = viewer.pagesCount
  const current = viewer.currentPageNumber
  pageLabel.textContent = `${current} / ${count}`
  previousButton.disabled = current <= 1
  nextButton.disabled = current >= count
}

function updateZoom(viewer: PDFViewer): void {
  zoomLabel.textContent = `${Math.round(viewer.currentScale * 100)}%`
}

async function main(): Promise<void> {
  if (bridge === undefined) {
    setStatus("The PDF reader bridge is unavailable. Reopen the document from the browser panel.", "error")
    fieldsLabel.textContent = "Unavailable"
    return
  }

  const source = new URL(location.href).searchParams.get("url")
  if (source === null || source.length === 0) {
    setStatus("The PDF reader was opened without a document URL.", "error")
    fieldsLabel.textContent = "Unavailable"
    return
  }

  setStatus("Downloading PDF…")
  const loaded = await bridge.load(source)
  const bytes = new Uint8Array(loaded.data)
  document.title = loaded.name
  fileLabel.textContent = loaded.name

  const eventBus = new EventBus()
  const linkService = new PDFLinkService({ eventBus })
  const findController = new PDFFindController({ eventBus, linkService })
  const viewer = new PDFViewer({
    container: viewerContainer,
    viewer: viewerElement,
    eventBus,
    linkService,
    findController,
    annotationMode: AnnotationMode.ENABLE_FORMS,
  })
  linkService.setViewer(viewer)

  eventBus.on("pagesinit", () => {
    viewer.currentScaleValue = "page-width"
    updatePageControls(viewer)
    updateZoom(viewer)
    setStatus("")
  })
  eventBus.on("pagechanging", () => updatePageControls(viewer))
  eventBus.on("scalechanging", () => updateZoom(viewer))

  previousButton.addEventListener("click", () => {
    if (viewer.currentPageNumber > 1) viewer.currentPageNumber -= 1
  })
  nextButton.addEventListener("click", () => {
    if (viewer.currentPageNumber < viewer.pagesCount) viewer.currentPageNumber += 1
  })
  zoomOutButton.addEventListener("click", () => {
    viewer.currentScale = Math.max(0.25, viewer.currentScale / 1.15)
  })
  zoomInButton.addEventListener("click", () => {
    viewer.currentScale = Math.min(5, viewer.currentScale * 1.15)
  })

  setStatus("Rendering PDF…")

  const pdfDocument = await getDocument({ data: bytes }).promise
  linkService.setDocument(pdfDocument, null)
  viewer.setDocument(pdfDocument)

  const fieldObjects = await pdfDocument.getFieldObjects().catch(() => null)
  const fieldCount = fieldObjects === null ? 0 : fieldObjects.size
  fieldsLabel.textContent =
    fieldCount === 0 ? "No form fields" : `${fieldCount} form field${fieldCount === 1 ? "" : "s"}`
  setControlsEnabled(true)
  saveButton.addEventListener("click", () => {
    void (async () => {
      saveButton.disabled = true
      setStatus("Saving filled PDF…")
      const bytesToSave = await pdfDocument.saveDocument()
      const saved = await bridge.save({ data: bytesToSave, name: loaded.name })
      setStatus(`Saved to ${saved.path}`, "success")
      saveButton.disabled = false
    })().catch((error: unknown) => {
      setStatus(`Could not save the PDF: ${errorMessage(error)}`, "error")
      saveButton.disabled = false
    })
  })
}

void main().catch((error: unknown) => {
  setStatus(errorMessage(error), "error")
  fieldsLabel.textContent = "Unavailable"
  setControlsEnabled(false)
})
