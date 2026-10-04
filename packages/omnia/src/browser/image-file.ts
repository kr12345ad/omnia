import { createHash } from "node:crypto"
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path"

export class ImageFileError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "ImageFileError"
    this.code = code
  }
}

export function extensionForMime(mime: string | undefined): string | undefined {
  switch (mime) {
    case "image/png":
      return ".png"
    case "image/jpeg":
      return ".jpg"
    case "image/gif":
      return ".gif"
    case "image/webp":
      return ".webp"
    case "image/svg+xml":
      return ".svg"
    case "image/avif":
      return ".avif"
    case "image/bmp":
      return ".bmp"
    default:
      return undefined
  }
}

export function mimeFromSource(src: string): string | undefined {
  if (src.startsWith("data:")) {
    const match = src.match(/^data:([^;,]+)/u)
    return match?.[1]
  }
  const pathname = tryPathname(src)
  if (pathname === undefined) return undefined
  const extension = extname(pathname).toLowerCase()
  switch (extension) {
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".gif":
      return "image/gif"
    case ".webp":
      return "image/webp"
    case ".svg":
      return "image/svg+xml"
    case ".avif":
      return "image/avif"
    case ".bmp":
      return "image/bmp"
    default:
      return undefined
  }
}

// Images land in ~/Downloads/omnia (override with OMNIA_BROWSER_DOWNLOAD_DIR);
// the write helper appends a numeric suffix instead of overwriting.
export function imageDownloadsDir(): string {
  const configured = process.env.OMNIA_BROWSER_DOWNLOAD_DIR
  return configured !== undefined && configured.length > 0 ? configured : join(homedir(), "Downloads", "omnia")
}

export function defaultImagePath(src: string, hint?: string, downloadsDir = imageDownloadsDir()): string {
  const raw = hint ?? decodePathBasename(src)
  const cleaned =
    raw
      .replace(/[^\w.\- ]+/gu, "")
      .trim()
      .replace(/\s+/gu, "-")
      .slice(0, 64) || "image"
  const existing = extname(cleaned)
  const extension = existing.length > 0 ? existing : (extensionForMime(mimeFromSource(src)) ?? ".png")
  const stem = existing.length > 0 ? cleaned.slice(0, -existing.length) : cleaned
  return join(downloadsDir, `${stem}${extension}`)
}

export function resolveImagePath(
  requested: string | undefined,
  src: string,
  hint: string | undefined,
  downloadsDir = imageDownloadsDir(),
  options: { readonly allowOutside?: boolean } = {},
): string {
  if (requested === undefined || requested.trim().length === 0) return defaultImagePath(src, hint, downloadsDir)
  const directory = resolve(downloadsDir)
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(directory, requested)
  // The server only sets allowOutside after an explicit FILES_WRITE decision
  // or for its own sandbox roots; the runtime still resolves the final path on
  // the machine that performs the write.
  if (options.allowOutside === true) return candidate
  // The runtime enforces the same sandbox on the machine that writes: the
  // downloads directory plus the OS temp directory (mirroring the server's
  // no-approval roots). relative() keeps Windows separators correct.
  const roots = [directory, resolve(tmpdir())]
  const contained = roots.some((root) => {
    if (candidate === root) return true
    const rest = relative(root, candidate)
    return rest.length > 0 && !rest.startsWith("..") && !isAbsolute(rest)
  })
  if (!contained) {
    throw new ImageFileError(
      "path_blocked",
      `Refusing to write outside ${directory}. Save image paths must stay inside the Omnia downloads directory.`,
    )
  }
  return candidate
}

// Re-reads the file that was just written so save/copy can report bytes and a
// content hash from disk instead of trusting the writer's own count.
export function verifyImageFile(path: string): { bytes: number; hash: string } {
  const bytes = readFileSync(path)
  return { bytes: bytes.length, hash: createHash("sha256").update(bytes).digest("hex") }
}

export function writeImageFile(path: string, bytes: Uint8Array): string {
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? path : withSuffix(path, attempt)
    try {
      const handle = openSync(candidate, "wx")
      try {
        writeSync(handle, bytes)
      } finally {
        closeSync(handle)
      }
      return candidate
    } catch (error) {
      if (isEexist(error)) continue
      throw error
    }
  }
  throw new ImageFileError("image_write_failed", "Could not find a free file name for the image.")
}

export function decodeDataUrl(src: string): { bytes: Buffer; mimeType?: string } | undefined {
  if (!src.startsWith("data:")) return undefined
  const comma = src.indexOf(",")
  if (comma < 0) return undefined
  const metadata = src.slice("data:".length, comma)
  const parts = metadata.split(";")
  if (!parts.some((part) => part.toLowerCase() === "base64")) return undefined
  const mimeType = parts[0] !== undefined && parts[0].length > 0 ? parts[0] : undefined
  return { bytes: Buffer.from(src.slice(comma + 1), "base64"), ...(mimeType === undefined ? {} : { mimeType }) }
}

function tryPathname(src: string): string | undefined {
  try {
    return new URL(src, "https://local.invalid").pathname
  } catch {
    return undefined
  }
}

function decodePathBasename(src: string): string {
  const pathname = tryPathname(src)
  const base = pathname === undefined ? src : basename(pathname)
  try {
    return decodeURIComponent(base)
  } catch {
    return base
  }
}

function withSuffix(path: string, index: number): string {
  const extension = extname(path)
  return extension.length === 0 ? `${path}-${index}` : `${path.slice(0, -extension.length)}-${index}${extension}`
}

function isEexist(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST"
}
