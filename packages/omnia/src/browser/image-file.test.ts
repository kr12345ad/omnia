import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ImageFileError,
  decodeDataUrl,
  defaultImagePath,
  extensionForMime,
  mimeFromSource,
  resolveImagePath,
  writeImageFile,
} from "./image-file"
import { buildImageFetchExpression, buildImageResolveExpression, buildImagesExpression } from "./page-script"

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "omnia-images-"))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("browser image files", () => {
  test("maps mime types and source extensions", () => {
    expect(mimeFromSource("https://example.com/cat.PNG?x=1")).toBe("image/png")
    expect(mimeFromSource("https://example.com/cat.jpeg")).toBe("image/jpeg")
    expect(mimeFromSource("data:image/webp;base64,AAAA")).toBe("image/webp")
    expect(extensionForMime("image/webp")).toBe(".webp")
  })

  test("survives malformed image sources", () => {
    expect(mimeFromSource("http://[")).toBeUndefined()
    expect(() => defaultImagePath("http://[")).not.toThrow()
  })

  test("derives a downloads path from the image name", () => {
    withTempDir((dir) => {
      const path = defaultImagePath("https://example.com/media/cute cat!.png", undefined, dir)
      expect(path.startsWith(dir)).toBe(true)
      expect(path.endsWith("cute-cat.png")).toBe(true)
    })
  })

  test("adds an extension when the hint has none", () => {
    withTempDir((dir) => {
      const path = defaultImagePath("https://example.com/photo", "sunset", dir)
      expect(path.endsWith("sunset.png")).toBe(true)
    })
  })

  test("contains explicit save paths inside the downloads directory and temp root", () => {
    withTempDir((dir) => {
      expect(resolveImagePath(join(dir, "shot.png"), "https://example.com/a.png", undefined, dir)).toBe(
        join(dir, "shot.png"),
      )
      expect(resolveImagePath("shot.png", "https://example.com/a.png", undefined, dir)).toBe(join(dir, "shot.png"))
      // Two levels up leaves the OS temp root, which is the runtime's own
      // no-approval sandbox alongside the downloads directory.
      expect(() =>
        resolveImagePath(join(dir, "..", "..", "escape.png"), "https://example.com/a.png", undefined, dir),
      ).toThrow(ImageFileError)
      expect(() => resolveImagePath("/etc/passwd", "https://example.com/a.png", undefined, dir)).toThrow(ImageFileError)
      // The server only sets allowOutside after a FILES_WRITE decision.
      expect(
        resolveImagePath("/etc/passwd", "https://example.com/a.png", undefined, dir, { allowOutside: true }),
      ).toBe("/etc/passwd")
    })
  })

  test("refuses a lexical path through a symlinked directory that leaves the root", () => {
    withTempDir((dir) => {
      // The temp root is one of the allowed roots, so the target must live
      // outside it for the symlink to actually escape containment.
      const outside = mkdtempSync(join(process.cwd(), ".omnia-images-outside-"))
      try {
        symlinkSync(outside, join(dir, "escape"), "dir")
        expect(() =>
          resolveImagePath(join(dir, "escape", "shot.png"), "https://example.com/a.png", undefined, dir),
        ).toThrow(ImageFileError)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })
  })

  test("writes images without overwriting existing files", () => {
    withTempDir((dir) => {
      const path = join(dir, "image.png")
      writeFileSync(path, "original")
      const written = writeImageFile(path, new Uint8Array([1, 2, 3]))
      expect(written).toBe(join(dir, "image-1.png"))
      expect(readFileSync(path, "utf8")).toBe("original")
      expect([...readFileSync(written)]).toEqual([1, 2, 3])
    })
  })

  test("decodes base64 data urls with parameters", () => {
    const decoded = decodeDataUrl("data:image/png;charset=utf-8;base64,aGVsbG8=")
    expect(decoded?.mimeType).toBe("image/png")
    expect(decoded?.bytes.toString("utf8")).toBe("hello")
    expect(decodeDataUrl("data:image/png,not-base64")).toBeUndefined()
  })
})

describe("browser image page scripts", () => {
  test("image listing keys elements with stable ids", () => {
    const expression = buildImagesExpression(10)
    expect(expression).toContain("data-omnia-image-id")
    expect(expression).toContain("omniaImageId")
    expect(expression).toContain("naturalWidth")
    expect(expression).toContain("10")
  })

  test("image resolution supports id, url, and query with ambiguity detection", () => {
    const expression = buildImageResolveExpression({ id: "img-2" })
    expect(expression).toContain('"img-2"')
    expect(expression).toContain("image_ambiguous")
    expect(buildImageResolveExpression({ url: "https://example.com/a.png" })).toContain("https://example.com/a.png")
    expect(buildImageResolveExpression({ query: "logo" })).toContain('"logo"')
  })

  test("image fetch omits credentials for cross-origin sources", () => {
    const expression = buildImageFetchExpression("https://example.com/a.png")
    expect(expression).toContain("FileReader")
    expect(expression).toContain("readAsDataURL")
    expect(expression).toContain('sameOrigin ? "include" : "omit"')
  })
})
